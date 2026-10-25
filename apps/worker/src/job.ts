import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR_ENV, protocolInstructions, RESULT_FILE_ENV, type AgentJobPayload, type AgentResult, type GitHubFeedbackReference, type JobContext, type JobDispatch, type PrResult, type StepOutputKind, type WorkflowStep } from '@sindral/shared';
import type { ApiClient } from './api.js';
import { collectOutputArtifacts, mergeArtifacts } from './artifacts.js';
import { collectDesignFiles, restoreDesignFiles } from './designFiles.js';
import { WorkerSessionStore } from './sessionStore.js';
import { runConflictResolution } from './conflict.js';
import { workdirPaths, type PublishCheck, type WorkerConfig } from './config.js';
import { buildAgentEnv, type EngineRegistry } from './engines/index.js';
import type { EngineRunOptions, EngineRunResult } from './engines/types.js';
import { JobEventStream } from './events.js';
import { gitAuth, gitIn } from './git.js';
import { commitAndPush, ensurePr, ghRunner, type GhRunner } from './github.js';
import type { Logger } from './logger.js';
import { buildPrompt, workspaceNote } from './prompt.js';
import { runRebaseStack } from './rebase.js';
import { runMergePullRequests } from './merge.js';
import { run as runCommand, type RunResult, type run } from './proc.js';
import { Redactor } from './redact.js';
import { describeFailure, extractJsonCandidate, markdownPlanResult, parseRawResult, readResultFile, summaryOf, validateResult } from './result.js';
import { assertPathContained, sanitizeTaskKey, type GitFactory, type Workspace, type WorkspaceManager } from './workspace.js';

export const SHUTDOWN_REASON = 'worker shutting down';
export const JOB_CANCELLED_REASON = 'job cancelled';
const PROGRESS_INTERVAL_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobDeps {
  config: WorkerConfig;
  api: Pick<ApiClient, 'postEvent' | 'complete' | 'fail' | 'cancel'>;
  sessionApi?: Pick<ApiClient, 'readDesignSession' | 'appendSession' | 'loadSession' | 'checkpointDesignSession'>;
  designInputApi?: Pick<ApiClient, 'readDesignInput'>;
  engines: EngineRegistry;
  workspaces: WorkspaceManager;
  logger: Logger;
  /** Overridable for tests. */
  gh?: (token: string | null) => GhRunner;
  git?: GitFactory;
  command?: typeof run;
  env?: NodeJS.ProcessEnv;
  progressIntervalMs?: number;
}

export type JobOutcome = { status: 'completed'; result: AgentResult; agentSessionId?: string | null } | { status: 'failed' | 'cancelled'; error: string };

interface AgentJobRun {
  result: AgentResult;
  agentSessionId: string | null;
}

/**
 * Runs one dispatched job end to end and reports the outcome to the server.
 * Never throws: every failure becomes a `fail` call with a redacted message.
 */
export async function runJob(dispatch: JobDispatch, deps: JobDeps, signal: AbortSignal): Promise<JobOutcome> {
  const { job, credentials } = dispatch;
  const log = deps.logger.child({ jobId: job.id, taskId: job.taskId, kind: job.kind });
  const redactor = new Redactor().add(deps.config.workerKey, credentials.githubToken, dispatch.lease.token, ...gitAuth(credentials.githubToken).secrets);
  const events = new JobEventStream(deps.api, job.id, job.attempt, dispatch.lease.token, redactor, log);
  let local = { write: (_line: string) => {}, close: async () => {} };
  const write = (line: string) => local.write(`${new Date().toISOString()} ${redactor.redact(line)}\n`);

  let outcome: JobOutcome;
  try {
    local = await openLocalLog(deps.config.workdir, job.id);
    write(`job ${job.id} started (${job.kind}, attempt ${job.attempt})`);
    const run =
      job.payload.kind === 'rebase-stack'
        ? {
            result: await runRebaseStack({
              payload: job.payload,
              workspaces: deps.workspaces,
              githubToken: credentials.githubToken,
              redactor,
              git: deps.git,
              signal,
              onProgress: (m) => {
                events.progress(m);
                write(m);
              },
            }),
            agentSessionId: null,
          }
        : job.payload.kind === 'resolve-rebase-conflict'
          ? {
              result: await runConflictResolution({
                dispatch,
                payload: job.payload,
                config: deps.config,
                workspaces: deps.workspaces,
                engines: deps.engines,
                redactor,
                githubToken: credentials.githubToken,
                signal,
                git: deps.git,
                command: deps.command,
                env: deps.env,
                onOutput: (line) => {
                  events.line(line);
                  write(line);
                },
                onProgress: (message) => {
                  events.progress(message);
                  write(message);
                },
              }),
              agentSessionId: null,
            }
          : job.payload.kind === 'merge-pull-requests'
            ? {
                result: await runMergePullRequests({
                  payload: job.payload,
                  githubToken: credentials.githubToken,
                  ghBin: deps.config.ghBin,
                  allowPatMerge: credentials.githubCredential === 'github-app' || deps.config.allowPatMerge,
                  gh: deps.gh?.(credentials.githubToken),
                  signal,
                  onProgress: (message) => {
                    events.progress(message);
                    write(message);
                  },
                }),
                agentSessionId: null,
              }
            : await runAgentJob(dispatch, job.payload, { ...deps, redactor, events, write, signal });
    await deps.api.complete(job.id, run.result, job.attempt, dispatch.lease.token, run.agentSessionId);
    write('job completed');
    outcome = { status: 'completed', result: run.result, ...(run.agentSessionId ? { agentSessionId: run.agentSessionId } : {}) };
  } catch (err) {
    const message = signal.aborted ? String(signal.reason ?? SHUTDOWN_REASON) : redactor.redactError(err);
    log.error({ err: message }, 'job failed');
    write(`job failed: ${message}`);
    if (signal.aborted && signal.reason === JOB_CANCELLED_REASON) {
      try {
        await deps.api.cancel(job.id, job.attempt, dispatch.lease.token);
      } catch (cancelErr) {
        log.error({ err: redactor.redactError(cancelErr) }, 'could not acknowledge job cancellation');
      }
    } else {
      try {
        await deps.api.fail(job.id, message.slice(0, 20_000), job.attempt, dispatch.lease.token);
      } catch (failErr) {
        log.error({ err: redactor.redactError(failErr) }, 'could not report job failure');
      }
    }
    outcome = signal.aborted && signal.reason === JOB_CANCELLED_REASON ? { status: 'cancelled', error: message } : { status: 'failed', error: message };
  } finally {
    await events.close();
    await local.close();
  }
  return outcome;
}

interface AgentJobContext extends JobDeps {
  redactor: Redactor;
  events: JobEventStream;
  write: (line: string) => void;
  signal: AbortSignal;
}

async function runAgentJob(dispatch: JobDispatch, payload: AgentJobPayload, ctx: AgentJobContext): Promise<AgentJobRun> {
  const { job, credentials } = dispatch;
  const { config, events, write, signal } = ctx;
  const step = payload.step;
  const output = step.output;
  if (!output) throw new Error(`Step "${step.label}" (${step.id}) has no output kind configured`);
  const engineName = step.engine ?? 'claude';
  const engine = ctx.engines[engineName];
  // Design uses the SDK's bundled executable, independently of the optional local CLI.
  const caps = output === 'design' ? { available: true } : await engine.probe();
  if (!caps.available) {
    const bin = engineName === 'claude' ? config.claudeBin : config.codexBin;
    const envVar = engineName === 'claude' ? 'SINDRAL_CLAUDE_BIN' : 'SINDRAL_CODEX_BIN';
    throw new Error(
      `Engine "${engineName}" is required by step "${step.label}" but the worker process cannot find or run "${bin}" on worker ${config.workerName}. ` +
        `If it works in an interactive SSH shell, configure the worker service with the same PATH, set SINDRAL_EXTRA_PATH, or set ${envVar} to the absolute binary path.`,
    );
  }

  const taskKey = payload.context.task_key || job.taskId;
  events.progress(`Preparing workspace for ${taskKey}`);
  let workspace = await ctx.workspaces.prepare({
    taskKey,
    repos: payload.repos,
    branch: payload.branch,
    baseBranch: payload.baseBranch,
    githubToken: credentials.githubToken,
  });

  const paths = workdirPaths(config.workdir);
  const jobId = assertJobId(job.id);
  const resultFile = path.join(paths.results, `${jobId}.json`);
  const outputDir = output === 'design' ? path.join(paths.designs, sanitizeTaskKey(taskKey)) : path.join(paths.outputs, jobId);
  await fsp.mkdir(paths.results, { recursive: true });
  await fsp.mkdir(paths.outputs, { recursive: true });
  await assertPathContained(config.workdir, paths.results);
  await assertPathContained(config.workdir, paths.outputs);
  await fsp.mkdir(outputDir, { recursive: true });
  await assertPathContained(config.workdir, outputDir);
  if (output === 'design') await fsp.utimes(outputDir, new Date(), new Date());
  await fsp.rm(resultFile, { force: true });

  let portableSession: EngineRunOptions['portableSession'];
  let resumeSessionId = payload.resumeSessionId;
  let flushSession: (() => Promise<void>) | undefined;
  const inputDirs: string[] = [];
  if (output === 'design') {
    if (engineName !== 'claude') throw new Error('Claude Design steps require the Claude engine');
    const api = ctx.sessionApi;
    if (!api) throw new Error('This worker does not support portable design sessions. Upgrade the worker.');
    const access = { attempt: job.attempt, leaseToken: dispatch.lease.token };
    const { checkpoint } = await api.readDesignSession(job.id, access);
    if (checkpoint) {
      await fsp.rm(outputDir, { recursive: true, force: true });
      await restoreDesignFiles(outputDir, checkpoint.files);
      resumeSessionId = checkpoint.sessionId;
    }
    const references = workspace.repos.map((repo) => `${repo.repo.full}: ${repo.dir}`);
    workspace = { ...workspace, cwd: outputDir, repos: [] };
    const persistenceController = new AbortController();
    const store = new WorkerSessionStore(api, job.id, access, (error) => { write(`Session persistence failed: ${error.message}`); persistenceController.abort(error); });
    if (resumeSessionId && !(await store.load({ projectKey: `sindral-task-${job.taskId}`, sessionId: resumeSessionId }))) {
      resumeSessionId = null;
      events.progress('Native session history is unavailable; continuing from the saved design context and files');
    }
    flushSession = () => store.flush();
    portableSession = {
      store, projectKey: `sindral-task-${job.taskId}`, signal: persistenceController.signal,
      onCheckpoint: async (sessionId) => {
        await store.flush();
        const files = await collectDesignFiles(outputDir);
        await api.checkpointDesignSession(job.id, { ...access, sessionId, files });
      },
    };
    step.prompt = `${step.prompt ?? ''}\n\nCurrent portable design workspace: ${outputDir}. All persistent design files belong here. Previous absolute worker paths may no longer exist. Reconcile the restored files and existing remote artifact before repeating interrupted operations.\nRead-only reference repositories:\n${references.join('\n') || '(none)'}`;
  }

  if (payload.designHandoff) {
    if (!ctx.designInputApi) throw new Error('This worker cannot download design handoffs. Upgrade the worker.');
    const { input } = await ctx.designInputApi.readDesignInput(job.id, { attempt: job.attempt, leaseToken: dispatch.lease.token });
    if (input.revisionId !== payload.designHandoff.revisionId) throw new Error('Design handoff revision does not match the job');
    const inputsDir = path.join(paths.designInputs, jobId);
    await fsp.mkdir(inputsDir, { recursive: true });
    await assertPathContained(config.workdir, inputsDir);
    await restoreDesignFiles(inputsDir, input.result.files);
    inputDirs.push(inputsDir);
    step.prompt = `${step.prompt ?? ''}\n\n## Approved design handoff\nRevision: ${input.revisionId}\nApproved: ${input.approvedAt}\nDesign source and assets: ${inputsDir}\nUse this frozen revision as input. Do not alter the handoff files.\n${input.result.specification}\n\nOpen design questions:\n${input.result.questions.join('\n') || 'None.'}`;
  }

  const prompt = `${output === 'design' ? '/design ' : ''}${buildPrompt({ step, output, context: payload.context, resultFile, outputDir, workspace })}`;
  const env = buildAgentEnv(ctx.env ?? process.env, {
    [RESULT_FILE_ENV]: resultFile,
    [OUTPUT_DIR_ENV]: outputDir,
    SINDRAL_TASK_KEY: taskKey,
    SINDRAL_JOB_ID: jobId,
  });

  write(`running ${engineName} in ${workspace.cwd}`);
  if (payload.resumeSessionId) write(`resuming ${engineName} session ${payload.resumeSessionId}`);
  events.progress(`Running ${engineName} for step "${step.label}"`);
  let lineCount = 0;
  const ticker = setInterval(() => events.progress(`Still running ${engineName} (${lineCount} output lines so far)`), ctx.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
  ticker.unref?.();
  let run: EngineRunResult | null = null;
  try {
    run = await engine.run({
      cwd: workspace.cwd,
      prompt,
      step,
      env,
      timeoutMs: config.jobTimeoutMs,
      signal,
      writableDirs: [paths.results, outputDir, ...inputDirs],
      resumeSessionId,
      portableSession,
      onOutput: (line) => {
        lineCount++;
        events.line(line);
        write(line);
      },
    });
  } finally {
    clearInterval(ticker);
  }
  if (run === null) throw new Error(`Engine "${engineName}" did not return a run result`);

  if (run.missing) throw new Error(`Engine "${engineName}" could not be started (binary not found)`);
  if (run.cancelled || signal.aborted) throw new Error(String(signal.reason ?? SHUTDOWN_REASON));
  if (run.timedOut) throw new Error(describeFailure(`timed out after ${Math.round(config.jobTimeoutMs / 60_000)} minutes`, run.tail, ctx.redactor));

  const exitNote = (r: EngineRunResult) => (r.exitCode === 0 ? '' : ` (${engineName} exited with code ${r.exitCode ?? 'unknown'})`);
  let resultText = await readResultFile(resultFile);
  if (resultText === null) {
    // Read-only steps cannot write files; accept the JSON from the final message instead.
    resultText = extractJsonCandidate(run.finalText);
    if (resultText !== null) write('result file missing; using JSON from the final agent message');
  }
  let fallbackPlan = resultText === null && output === 'plan' ? markdownPlanResult(run.finalText) : null;
  if (fallbackPlan) write('result file missing; using Markdown from the final agent message as the plan');
  let parsed = fallbackPlan ? { ok: true as const, value: fallbackPlan } : parseRawResult(resultText, output);
  if (!parsed.ok) {
    const reason = parsed.reason;
    write(`result file unusable (${reason}); running one recovery pass`);
    events.progress(`Recovering result for step "${step.label}"`);
    await fsp.rm(resultFile, { force: true });
    const recovery = await engine.run({
      cwd: workspace.cwd,
      prompt: buildResultRecoveryPrompt({ step, output, context: payload.context, resultFile, outputDir, workspace, reason }),
      step,
      env,
      timeoutMs: config.jobTimeoutMs,
      signal,
      writableDirs: [paths.results, outputDir, ...inputDirs],
      resumeSessionId: run.sessionId ?? payload.resumeSessionId,
      portableSession,
      onOutput: (line) => {
        lineCount++;
        events.line(line);
        write(line);
      },
    });
    if (recovery.missing) throw new Error(`Engine "${engineName}" could not be started (binary not found)`);
    if (recovery.cancelled || signal.aborted) throw new Error(String(signal.reason ?? SHUTDOWN_REASON));
    if (recovery.timedOut) throw new Error(describeFailure(`result recovery timed out after ${Math.round(config.jobTimeoutMs / 60_000)} minutes`, recovery.tail, ctx.redactor));
    run = recovery;
    resultText = await readResultFile(resultFile);
    if (resultText === null) {
      resultText = extractJsonCandidate(recovery.finalText);
      if (resultText !== null) write('result recovery did not write the file; using JSON from the recovery final message');
    } else {
      write('result recovery wrote the missing result file');
    }
    fallbackPlan = resultText === null && output === 'plan' ? markdownPlanResult(recovery.finalText) : null;
    if (fallbackPlan) write('result recovery returned Markdown in the final message as the plan');
    parsed = fallbackPlan ? { ok: true as const, value: fallbackPlan } : parseRawResult(resultText, output);
  }
  if (!parsed.ok) throw new Error(describeFailure(`${parsed.reason}${exitNote(run)}`, run.tail, ctx.redactor));
  const raw = parsed.value;

  let candidate: Record<string, unknown> = raw;
  if (raw.kind === 'pr' || raw.kind === 'review-slice') {
    const summary = summaryOf(raw);
    if (!summary) throw new Error(describeFailure(`the result has no summary${exitNote}`, run.tail, ctx.redactor));
    if (workspace.repos.length === 0) throw new Error(`A "${raw.kind}" step requires at least one repository on the task`);
    const agentMotivation = typeof raw['motivation'] === 'string' ? raw['motivation'].trim() : '';
    const published = await publishPr({
      ...ctx,
      workspace,
      taskKey,
      taskTitle: payload.context.task_title,
      motivation: agentMotivation || payload.context.task_description.trim() || undefined,
      proposedSolution: stringField(raw, 'proposedSolution') || stringField(raw, 'proposed_solution') || undefined,
      assumptions: typeof raw['assumptions'] === 'string' ? raw['assumptions'] : undefined,
      risks: stringField(raw, 'risks') || undefined,
      acceptanceCriteria: stringField(raw, 'acceptanceCriteria') || payload.context.acceptance_criteria.trim() || undefined,
      testing: stringField(raw, 'testing') || undefined,
      summary,
      token: credentials.githubToken,
      redactor: ctx.redactor,
      jobId: dispatch.job.id,
      githubFeedback: payload.context.github_feedback,
    });
    candidate = { ...raw, ...published, kind: raw.kind };
  } else if (raw.kind === 'document') {
    const collected = await collectOutputArtifacts(outputDir);
    candidate = { ...raw, artifacts: mergeArtifacts(raw['artifacts'], collected) };
  } else if (raw.kind === 'design') {
    candidate = { ...raw, files: raw['designUrl'] === null ? [] : await collectDesignFiles(outputDir) };
  }

  await flushSession?.();

  const validated = validateResult(candidate);
  if (!validated.ok) throw new Error(describeFailure(`${validated.reason}${exitNote}`, run.tail, ctx.redactor));
  return { result: validated.value, agentSessionId: run.sessionId };
}

function buildResultRecoveryPrompt(input: {
  step: WorkflowStep;
  output: StepOutputKind;
  context: Partial<JobContext>;
  resultFile: string;
  outputDir: string;
  workspace: Workspace;
  reason: string;
}): string {
  const context = input.context;
  const lines = [
    `The previous run for step "${input.step.label}" (${input.step.id}) finished, but Sindral could not parse the required result file.`,
    `Failure reason: ${input.reason}`,
    '',
    'Your only job is to recover the machine-readable step result.',
    'Do not modify repository files, create commits, rewrite branches, push, or open pull requests.',
    'Inspect the workspace, git history, and task context only as needed to summarize the work that already happened.',
    '',
    'Task context:',
    `- Task key: ${context.task_key ?? ''}`,
    `- Title: ${context.task_title ?? ''}`,
    `- Description: ${context.task_description ?? ''}`,
    `- Required outcome: ${context.task_outcome ?? ''}`,
    `- Acceptance criteria: ${context.acceptance_criteria ?? ''}`,
    `- Feedback being addressed: ${context.feedback ?? ''}`,
    '',
    protocolInstructions(input.output, input.resultFile),
    workspaceNote(input.workspace, input.outputDir, false),
  ];
  return lines.join('\n');
}

interface PublishOptions extends AgentJobContext {
  workspace: Awaited<ReturnType<WorkspaceManager['prepare']>>;
  taskKey: string;
  taskTitle: string;
  motivation?: string;
  proposedSolution?: string;
  assumptions?: string;
  risks?: string;
  acceptanceCriteria?: string;
  testing?: string;
  summary: string;
  token: string | null;
  jobId: string;
  githubFeedback?: GitHubFeedbackReference;
}

function stringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function publishPr(opts: PublishOptions): Promise<Record<string, unknown>> {
  const auth = gitAuth(opts.token);
  const gitFactory = opts.git ?? gitIn;
  const gh = (opts.gh ?? ((token) => ghRunner(opts.config.ghBin, token)))(opts.token);
  let prUrl: string | null = null;
  let branch = '';
  const pullRequests: NonNullable<PrResult['pullRequests']> = [];
  for (const repo of opts.workspace.repos) {
    if (opts.signal.aborted) throw new Error(String(opts.signal.reason ?? SHUTDOWN_REASON));
    opts.events.progress(`Pushing ${repo.branch} to ${repo.repo.full}`);
    const git = gitFactory(repo.dir, auth);
    const { committed, omittedWorkflowPaths } = await commitAndPush(git, {
      taskKey: opts.taskKey,
      summary: opts.summary,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      beforePush: () => runPublishChecks({
        checks: opts.config.publishChecks,
        mode: opts.config.publishCheckMode,
        timeoutMs: opts.config.publishCheckTimeoutMs,
        cwd: repo.dir,
        command: opts.command,
        signal: opts.signal,
        onProgress: (message) => {
          opts.events.progress(message);
          opts.write(`${repo.repo.full}: ${message}`);
        },
      }),
      onRecovery: (message) => {
        opts.events.progress(message);
        opts.write(`${repo.repo.full}: ${message}`);
      },
    });
    if (omittedWorkflowPaths.length > 0) {
      opts.write(`${repo.repo.full}: omitted GitHub Actions workflow changes from ${omittedWorkflowPaths.join(', ')}`);
    }
    opts.write(`${repo.repo.full}: pushed ${repo.branch}${committed ? ' (committed leftover changes)' : ''}`);
    const pr = await ensurePr({
      gh,
      cwd: repo.dir,
      repo: repo.repo,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      taskKey: opts.taskKey,
      taskTitle: opts.taskTitle,
      motivation: opts.motivation,
      proposedSolution: opts.proposedSolution,
      assumptions: opts.assumptions,
      risks: opts.risks,
      acceptanceCriteria: opts.acceptanceCriteria,
      testing: opts.testing,
      summary: opts.summary,
      jobId: opts.jobId,
      githubFeedback: opts.githubFeedback,
    });
    opts.write(`${repo.repo.full}: ${pr.created ? 'opened' : 'commented on'} ${pr.url}`);
    opts.events.message(`${pr.created ? 'Opened' : 'Updated'} pull request ${pr.url}`);
    const number = Number(/\/pull\/(\d+)(?:$|[?#])/.exec(pr.url)?.[1]);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`Pull request URL has no valid number: ${pr.url}`);
    const headSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    pullRequests.push({
      repository: repo.repo.full,
      prUrl: pr.url,
      number,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      ...(/^[0-9a-f]{40}$/i.test(headSha) ? { headSha } : {}),
    });
    prUrl ??= pr.url;
    branch ||= repo.branch;
  }
  if (!prUrl) throw new Error('no pull request was created');
  return { kind: 'pr', summary: opts.summary, prUrl, branch, pullRequests };
}

async function runPublishChecks(opts: {
  checks: readonly PublishCheck[];
  mode: WorkerConfig['publishCheckMode'];
  timeoutMs: number;
  cwd: string;
  command?: typeof run;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<void> {
  if (opts.mode === 'off' || opts.checks.length === 0) return;
  const command = opts.command ?? runCommand;
  opts.onProgress(`Running ${opts.checks.length} publish check${opts.checks.length === 1 ? '' : 's'} (${opts.mode})`);
  const failures: string[] = [];
  for (const check of opts.checks) {
    opts.onProgress(`Running publish check: ${[check.command, ...check.args].join(' ')}`);
    const result = await command(check.command, check.args, { cwd: opts.cwd, signal: opts.signal, timeoutMs: opts.timeoutMs });
    if (result.failed || result.exitCode !== 0) {
      failures.push(formatCheckFailure(check, result));
      opts.onProgress(`Publish check failed: ${check.command}`);
      if (opts.mode === 'strict') break;
    }
  }
  if (failures.length > 0 && opts.mode === 'strict') {
    throw new Error(`Publish checks failed; fix these before publishing:\n\n${failures.join('\n\n')}`);
  }
  if (failures.length > 0) {
    opts.onProgress(`Publish checks failed in advisory mode; publishing will continue.`);
  }
}

function formatCheckFailure(check: PublishCheck, result: RunResult): string {
  const output = (result.stderr.trim() || result.stdout.trim() || result.message).slice(0, 4_000);
  return `$ ${[check.command, ...check.args].join(' ')}\nexit ${result.exitCode ?? result.code ?? '?'}${output ? `\n${output}` : ''}`;
}

function assertJobId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Job id ${JSON.stringify(id)} is not a UUID`);
  return id;
}

async function openLocalLog(workdir: string, jobId: string): Promise<{ write: (line: string) => void; close: () => Promise<void> }> {
  const dir = workdirPaths(workdir).logs;
  await fsp.mkdir(dir, { recursive: true });
  await assertPathContained(workdir, dir);
  const file = path.join(dir, `${assertJobId(jobId)}.log`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => {
    /* local logging must never fail a job */
  });
  return {
    write: (line) => {
      if (!stream.destroyed) stream.write(line);
    },
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}
