import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR_ENV, RESULT_FILE_ENV, type AgentJobPayload, type AgentResult, type GitHubFeedbackReference, type JobDispatch, type PrResult } from '@sindral/shared';
import type { ApiClient } from './api.js';
import { collectOutputArtifacts, mergeArtifacts } from './artifacts.js';
import { runConflictResolution } from './conflict.js';
import { workdirPaths, type WorkerConfig } from './config.js';
import { buildAgentEnv, type EngineRegistry } from './engines/index.js';
import { JobEventStream } from './events.js';
import { gitAuth, gitIn } from './git.js';
import { commitAndPush, ensurePr, ghRunner, type GhRunner } from './github.js';
import type { Logger } from './logger.js';
import { buildPrompt } from './prompt.js';
import { runRebaseStack } from './rebase.js';
import { runMergePullRequests } from './merge.js';
import type { run } from './proc.js';
import { Redactor } from './redact.js';
import { describeFailure, extractJsonCandidate, parseRawResult, readResultFile, summaryOf, validateResult } from './result.js';
import type { GitFactory, WorkspaceManager } from './workspace.js';

export const SHUTDOWN_REASON = 'worker shutting down';
const PROGRESS_INTERVAL_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobDeps {
  config: WorkerConfig;
  api: Pick<ApiClient, 'postEvent' | 'complete' | 'fail'>;
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

export type JobOutcome = { status: 'completed'; result: AgentResult } | { status: 'failed'; error: string };

/**
 * Runs one dispatched job end to end and reports the outcome to the server.
 * Never throws: every failure becomes a `fail` call with a redacted message.
 */
export async function runJob(dispatch: JobDispatch, deps: JobDeps, signal: AbortSignal): Promise<JobOutcome> {
  const { job, credentials } = dispatch;
  const log = deps.logger.child({ jobId: job.id, taskId: job.taskId, kind: job.kind });
  const redactor = new Redactor().add(deps.config.workerKey, credentials.githubToken, ...gitAuth(credentials.githubToken).secrets);
  const events = new JobEventStream(deps.api, job.id, redactor, log);
  const local = await openLocalLog(deps.config.workdir, job.id);
  const write = (line: string) => local.write(`${new Date().toISOString()} ${redactor.redact(line)}\n`);

  let outcome: JobOutcome;
  try {
    write(`job ${job.id} started (${job.kind}, attempt ${job.attempt})`);
    const result =
      job.payload.kind === 'rebase-stack'
        ? await runRebaseStack({
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
          })
        : job.payload.kind === 'resolve-rebase-conflict'
          ? await runConflictResolution({
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
            })
          : job.payload.kind === 'merge-pull-requests'
            ? await runMergePullRequests({
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
              })
            : await runAgentJob(dispatch, job.payload, { ...deps, redactor, events, write, signal });
    await deps.api.complete(job.id, result, job.attempt);
    write('job completed');
    outcome = { status: 'completed', result };
  } catch (err) {
    const message = signal.aborted ? String(signal.reason ?? SHUTDOWN_REASON) : redactor.redactError(err);
    log.error({ err: message }, 'job failed');
    write(`job failed: ${message}`);
    try {
      await deps.api.fail(job.id, message.slice(0, 20_000), job.attempt);
    } catch (failErr) {
      log.error({ err: redactor.redactError(failErr) }, 'could not report job failure');
    }
    outcome = { status: 'failed', error: message };
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

async function runAgentJob(dispatch: JobDispatch, payload: AgentJobPayload, ctx: AgentJobContext): Promise<AgentResult> {
  const { job, credentials } = dispatch;
  const { config, events, write, signal } = ctx;
  const step = payload.step;
  const output = step.output;
  if (!output) throw new Error(`Step "${step.label}" (${step.id}) has no output kind configured`);
  const engineName = step.engine ?? 'claude';
  const engine = ctx.engines[engineName];
  const caps = await engine.probe();
  if (!caps.available) {
    const bin = engineName === 'claude' ? config.claudeBin : config.codexBin;
    throw new Error(`Engine "${engineName}" is required by step "${step.label}" but the binary "${bin}" is not installed on worker ${config.workerName}`);
  }

  const taskKey = payload.context.task_key || job.taskId;
  events.progress(`Preparing workspace for ${taskKey}`);
  const workspace = await ctx.workspaces.prepare({
    taskKey,
    repos: payload.repos,
    branch: payload.branch,
    baseBranch: payload.baseBranch,
    githubToken: credentials.githubToken,
  });

  const paths = workdirPaths(config.workdir);
  const jobId = assertJobId(job.id);
  const resultFile = path.join(paths.results, `${jobId}.json`);
  const outputDir = path.join(paths.outputs, jobId);
  await fsp.mkdir(paths.results, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.rm(resultFile, { force: true });

  const prompt = buildPrompt({ step, output, context: payload.context, resultFile, outputDir, workspace });
  const env = buildAgentEnv(ctx.env ?? process.env, {
    [RESULT_FILE_ENV]: resultFile,
    [OUTPUT_DIR_ENV]: outputDir,
    SINDRAL_TASK_KEY: taskKey,
    SINDRAL_JOB_ID: jobId,
  });

  write(`running ${engineName} in ${workspace.cwd}`);
  events.progress(`Running ${engineName} for step "${step.label}"`);
  let lineCount = 0;
  const ticker = setInterval(() => events.progress(`Still running ${engineName} (${lineCount} output lines so far)`), ctx.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
  ticker.unref?.();
  let run;
  try {
    run = await engine.run({
      cwd: workspace.cwd,
      prompt,
      step,
      env,
      timeoutMs: config.jobTimeoutMs,
      signal,
      writableDirs: [paths.results, outputDir],
      onOutput: (line) => {
        lineCount++;
        events.line(line);
        write(line);
      },
    });
  } finally {
    clearInterval(ticker);
  }

  if (run.missing) throw new Error(`Engine "${engineName}" could not be started (binary not found)`);
  if (run.cancelled || signal.aborted) throw new Error(String(signal.reason ?? SHUTDOWN_REASON));
  if (run.timedOut) throw new Error(describeFailure(`timed out after ${Math.round(config.jobTimeoutMs / 60_000)} minutes`, run.tail, ctx.redactor));

  const exitNote = run.exitCode === 0 ? '' : ` (${engineName} exited with code ${run.exitCode ?? 'unknown'})`;
  let resultText = await readResultFile(resultFile);
  if (resultText === null) {
    // Read-only steps cannot write files; accept the JSON from the final message instead.
    resultText = extractJsonCandidate(run.finalText);
    if (resultText !== null) write('result file missing; using JSON from the final agent message');
  }
  const parsed = parseRawResult(resultText, output);
  if (!parsed.ok) throw new Error(describeFailure(`${parsed.reason}${exitNote}`, run.tail, ctx.redactor));
  const raw = parsed.value;

  let candidate: Record<string, unknown> = raw;
  if (raw.kind === 'pr') {
    const summary = summaryOf(raw);
    if (!summary) throw new Error(describeFailure(`the result has no summary${exitNote}`, run.tail, ctx.redactor));
    if (workspace.repos.length === 0) throw new Error('A "pr" step requires at least one repository on the task');
    candidate = await publishPr({
      ...ctx,
      workspace,
      taskKey,
      taskTitle: payload.context.task_title,
      summary,
      token: credentials.githubToken,
      redactor: ctx.redactor,
      jobId: dispatch.job.id,
      githubFeedback: payload.context.github_feedback,
    });
  } else if (raw.kind === 'document') {
    const collected = await collectOutputArtifacts(outputDir);
    candidate = { ...raw, artifacts: mergeArtifacts(raw['artifacts'], collected) };
  }

  const validated = validateResult(candidate);
  if (!validated.ok) throw new Error(describeFailure(`${validated.reason}${exitNote}`, run.tail, ctx.redactor));
  return validated.value;
}

interface PublishOptions extends AgentJobContext {
  workspace: Awaited<ReturnType<WorkspaceManager['prepare']>>;
  taskKey: string;
  taskTitle: string;
  summary: string;
  token: string | null;
  jobId: string;
  githubFeedback?: GitHubFeedbackReference;
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
    const { committed } = await commitAndPush(git, { taskKey: opts.taskKey, summary: opts.summary, branch: repo.branch });
    opts.write(`${repo.repo.full}: pushed ${repo.branch}${committed ? ' (committed leftover changes)' : ''}`);
    const pr = await ensurePr({
      gh,
      cwd: repo.dir,
      repo: repo.repo,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      taskKey: opts.taskKey,
      taskTitle: opts.taskTitle,
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

function assertJobId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Job id ${JSON.stringify(id)} is not a UUID`);
  return id;
}

async function openLocalLog(workdir: string, jobId: string): Promise<{ write: (line: string) => void; close: () => Promise<void> }> {
  const dir = workdirPaths(workdir).logs;
  await fsp.mkdir(dir, { recursive: true });
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
