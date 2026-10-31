import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  OUTPUT_DIR_ENV,
  RESULT_FILE_ENV,
  type ConflictResolutionResult,
  type JobDispatch,
  type ResolveRebaseConflictJobPayload,
  type WorkflowStep,
} from '@sindral/shared';
import { workdirPaths, type WorkerConfig } from './config.js';
import { buildAgentEnv, type EngineRegistry } from './engines/index.js';
import { assertBranchName, gitAuth, gitIn } from './git.js';
import { buildPrompt } from './prompt.js';
import { run, type RunResult } from './proc.js';
import { readResultFile, parseRawResult, validateResult } from './result.js';
import type { Redactor } from './redact.js';
import { assertPathContained, parseRepo, worktreeDir, type GitFactory, type WorkspaceManager } from './workspace.js';

const SHA_RE = /^[0-9a-f]{40}$/i;
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export interface ConflictResolutionOptions {
  dispatch: JobDispatch;
  payload: ResolveRebaseConflictJobPayload;
  config: WorkerConfig;
  workspaces: WorkspaceManager;
  engines: EngineRegistry;
  redactor: Redactor;
  githubToken: string | null;
  signal: AbortSignal;
  git?: GitFactory;
  command?: typeof run;
  env?: NodeJS.ProcessEnv;
  onOutput?: (line: string) => void;
  onProgress?: (message: string) => void;
}

/**
 * Reproduces one pinned rebase conflict, lets an agent edit only the conflicted
 * files, validates the staged resolution, completes the rebase and pushes with
 * an explicit force-with-lease. Unsafe/ambiguous cases return `resolved:false`
 * without modifying the remote branch.
 */
export async function runConflictResolution(opts: ConflictResolutionOptions): Promise<ConflictResolutionResult> {
  const { payload } = opts;
  const unresolved = (error: string, rationale = ''): ConflictResolutionResult => ({
    kind: 'conflict-resolution',
    summary: `Automatic conflict resolution escalated: ${error}`,
    taskId: payload.taskId,
    branch: payload.branch,
    resolved: false,
    rationale,
    resolvedPaths: [],
    checks: [],
    error,
  });

  if (!SHA_RE.test(payload.sourceSha) || !SHA_RE.test(payload.targetSha)) return unresolved('The dispatched commit SHA is invalid');
  const unsafePath = [...payload.conflictedPaths, ...payload.policy.allowedPaths].find((file) => !isSafeRelativePath(file));
  if (unsafePath) return unresolved(`Unsafe conflict path requires human review: ${unsafePath}`);
  const branch = assertBranchName(payload.branch);
  const protectedConflict = payload.conflictedPaths.find((file) => isProtectedPath(file, payload.policy.protectedPaths));
  if (protectedConflict) return unresolved(`Protected file requires human review: ${protectedConflict}`);
  if (payload.conflictedPaths.length > payload.policy.maxFiles) return unresolved(`Conflict touches ${payload.conflictedPaths.length} files; limit is ${payload.policy.maxFiles}`);

  const repo = parseRepo(payload.repository);
  const auth = gitAuth(opts.githubToken);
  opts.redactor.add(...auth.secrets);
  const repoDir = await opts.workspaces.ensureRepo(repo, auth);
  const gitFactory = opts.git ?? gitIn;
  const repoGit = gitFactory(repoDir, auth);
  const remoteSource = (await repoGit(['rev-parse', `origin/${branch}`])).stdout.trim();
  const remoteTarget = (await repoGit(['rev-parse', payload.targetSha])).stdout.trim();
  if (remoteSource !== payload.sourceSha || remoteTarget !== payload.targetSha) return unresolved('Branch heads changed after the conflict was recorded');

  const dir = worktreeDir(opts.config.workdir, `conflict__${payload.taskKey}`, repo);
  await repoGit.try(['worktree', 'remove', '--force', dir]);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(opts.config.workdir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await assertPathContained(opts.config.workdir, path.dirname(dir));
  await repoGit(['worktree', 'add', '--detach', dir, payload.sourceSha]);
  // Real git creates the directory; keeping this idempotent also makes custom
  // GitFactory implementations obey the workspace contract.
  await fs.mkdir(dir, { recursive: true });
  await assertPathContained(opts.config.workdir, dir);
  const wt = gitFactory(dir, auth);
  try {
    const rebase = await wt.try(['-c', 'user.name=Sindral AI', '-c', 'user.email=sindral@users.noreply.github.com', 'rebase', payload.targetSha]);
    if (!rebase.failed && rebase.exitCode === 0) {
      return await validateAndPush(opts, wt, dir, branch, { summary: 'Rebase no longer conflicts', rationale: 'The pinned rebase completed without a conflict.', resolvedPaths: [] });
    }

    const actual = parseNul((await wt.try(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout);
    if (!sameSet(actual, payload.conflictedPaths)) {
      await wt.try(['rebase', '--abort']);
      return unresolved(`Conflict set changed (expected ${payload.conflictedPaths.join(', ')}, found ${actual.join(', ') || 'none'})`);
    }
    const conflictNumstat = (await wt.try(['diff', '--numstat', '--', ...payload.conflictedPaths])).stdout;
    if (conflictNumstat.split('\n').some((line) => line.startsWith('-\t-\t'))) {
      await wt.try(['rebase', '--abort']);
      return unresolved('Binary conflicts require human review');
    }

    const paths = workdirPaths(opts.config.workdir);
    await fs.mkdir(paths.results, { recursive: true });
    await fs.mkdir(paths.outputs, { recursive: true });
    await assertPathContained(opts.config.workdir, paths.results);
    await assertPathContained(opts.config.workdir, paths.outputs);
    const resultFile = path.join(paths.results, `${opts.dispatch.job.id}.json`);
    const outputDir = path.join(paths.outputs, opts.dispatch.job.id);
    await fs.mkdir(outputDir, { recursive: true });
    await assertPathContained(opts.config.workdir, outputDir);
    await fs.rm(resultFile, { force: true });

    const step: WorkflowStep = {
      id: 'resolve-rebase-conflict',
      type: 'agent',
      label: 'Resolve stacked rebase conflict',
      state: 'conflict-resolution',
      engine: payload.engine,
      model: payload.model,
      mode: payload.mode,
      output: 'conflict-resolution',
      tools: ['read_file', 'write_file', 'search_codebase', 'list_directory'],
      permissions: ['read', 'write'],
      prompt: conflictPrompt(payload),
    };
    const engine = opts.engines[payload.engine];
    const caps = await engine.probe();
    if (!caps.available) {
      await wt.try(['rebase', '--abort']);
      return unresolved(`Conflict-resolution engine ${payload.engine} is unavailable`);
    }
    const env = buildAgentEnv(opts.env ?? process.env, {
      [RESULT_FILE_ENV]: resultFile,
      [OUTPUT_DIR_ENV]: outputDir,
      SINDRAL_TASK_KEY: payload.taskKey,
      SINDRAL_JOB_ID: opts.dispatch.job.id,
    });
    opts.onProgress?.(`Resolving conflicts in ${payload.branch}`);
    const runResult = await engine.run({
      cwd: dir,
      prompt: buildPrompt({
        step,
        output: 'conflict-resolution',
        context: payload.context,
        resultFile,
        outputDir,
        workspace: {
          taskKey: payload.taskKey,
          cwd: dir,
          repos: [{ repo, repoDir, dir, branch, baseBranch: payload.baseBranch, resumed: true }],
        },
      }),
      step,
      env,
      timeoutMs: opts.config.jobTimeoutMs,
      signal: opts.signal,
      writableDirs: [paths.results, outputDir],
      onOutput: (line) => opts.onOutput?.(line),
    });
    if (runResult.cancelled || runResult.timedOut || runResult.missing || runResult.exitCode !== 0) {
      await wt.try(['rebase', '--abort']);
      return unresolved('The conflict-resolution agent did not complete successfully');
    }
    const parsed = parseRawResult(await readResultFile(resultFile), 'conflict-resolution');
    if (!parsed.ok) {
      await wt.try(['rebase', '--abort']);
      return unresolved(parsed.reason);
    }
    const validated = validateResult(parsed.value);
    if (!validated.ok || validated.value.kind !== 'conflict-resolution') {
      await wt.try(['rebase', '--abort']);
      return unresolved(validated.ok ? 'Agent returned the wrong result kind' : validated.reason);
    }
    const agentResult = validated.value;
    if (agentResult.taskId !== payload.taskId || agentResult.branch !== payload.branch || !agentResult.resolved) {
      await wt.try(['rebase', '--abort']);
      return unresolved(agentResult.error ?? 'Agent could not prove a safe resolution', agentResult.rationale);
    }

    const statusPaths = await changedPaths(wt);
    const allowed = new Set([...payload.conflictedPaths, ...payload.policy.allowedPaths]);
    const unexpected = statusPaths.filter((file) => !allowed.has(file));
    if (unexpected.length > 0) {
      await wt.try(['rebase', '--abort']);
      return unresolved(`Resolution modified paths outside the allow-list: ${unexpected.join(', ')}`, agentResult.rationale);
    }
    if (statusPaths.some((file) => isProtectedPath(file, payload.policy.protectedPaths))) {
      await wt.try(['rebase', '--abort']);
      return unresolved('Resolution modified a protected file', agentResult.rationale);
    }
    for (const file of payload.conflictedPaths) {
      const content = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
      if (CONFLICT_MARKER_RE.test(content)) {
        await wt.try(['rebase', '--abort']);
        return unresolved(`Conflict markers remain in ${file}`, agentResult.rationale);
      }
    }
    await wt(['add', '--', ...payload.conflictedPaths]);
    const changedLines = parseNumstat((await wt(['diff', '--cached', '--numstat'])).stdout);
    if (changedLines > payload.policy.maxChangedLines) {
      await wt.try(['rebase', '--abort']);
      return unresolved(`Resolution changes ${changedLines} lines; limit is ${payload.policy.maxChangedLines}`, agentResult.rationale);
    }
    const continued = await wt.try(['rebase', '--continue'], { env: { GIT_EDITOR: 'true' } });
    if (continued.failed || continued.exitCode !== 0) {
      await wt.try(['rebase', '--abort']);
      return unresolved('Rebase produced another conflict; only one automatic attempt is allowed', agentResult.rationale);
    }
    return await validateAndPush(opts, wt, dir, branch, {
      summary: agentResult.summary,
      rationale: agentResult.rationale,
      resolvedPaths: statusPaths,
    });
  } finally {
    await repoGit.try(['worktree', 'remove', '--force', dir]);
    await fs.rm(dir, { recursive: true, force: true });
    await repoGit.try(['worktree', 'prune']);
  }
}

async function validateAndPush(
  opts: ConflictResolutionOptions,
  wt: ReturnType<GitFactory>,
  cwd: string,
  branch: string,
  resolution: { summary: string; rationale: string; resolvedPaths: string[] },
): Promise<ConflictResolutionResult> {
  const status = (await wt(['status', '--porcelain=v1'])).stdout.trim();
  if (status) {
    return {
      kind: 'conflict-resolution',
      summary: 'Automatic conflict resolution escalated: the rebased worktree is not clean',
      taskId: opts.payload.taskId,
      branch,
      resolved: false,
      rationale: resolution.rationale,
      resolvedPaths: resolution.resolvedPaths,
      checks: [],
      error: 'Resolved rebase left uncommitted changes',
    };
  }
  const command = opts.command ?? run;
  const commands = opts.payload.policy.validationCommands.length > 0 ? opts.payload.policy.validationCommands : await detectValidationCommands(cwd);
  if (commands.length === 0) {
    await wt.try(['rebase', '--abort']);
    return {
      kind: 'conflict-resolution',
      summary: 'Automatic conflict resolution escalated: no validation commands are configured',
      taskId: opts.payload.taskId,
      branch,
      resolved: false,
      rationale: resolution.rationale,
      resolvedPaths: resolution.resolvedPaths,
      checks: [],
      error: 'No validation commands are configured for this repository',
    };
  }
  const checks: ConflictResolutionResult['checks'] = [];
  for (const [file, ...args] of commands) {
    if (!file) continue;
    const result = await command(file, args, { cwd, signal: opts.signal, timeoutMs: opts.config.jobTimeoutMs });
    const output = opts.redactor.redact((result.stderr || result.stdout || result.message).slice(0, 20_000));
    checks.push({ command: [file, ...args], ok: !result.failed && result.exitCode === 0, output });
    if (result.failed || result.exitCode !== 0) {
      return {
        kind: 'conflict-resolution',
        summary: `Automatic conflict resolution escalated: validation failed (${file} ${args.join(' ')})`,
        taskId: opts.payload.taskId,
        branch,
        resolved: false,
        rationale: resolution.rationale,
        resolvedPaths: resolution.resolvedPaths,
        checks,
        error: 'Resolved tree failed required validation',
      };
    }
  }
  const head = (await wt(['rev-parse', 'HEAD'])).stdout.trim();
  if (!SHA_RE.test(head)) throw new Error('Resolved rebase did not produce a valid commit SHA');
  const diff = (await wt(['diff', '--binary', opts.payload.targetSha, 'HEAD'])).stdout;
  const resolutionDiffHash = createHash('sha256').update(diff).digest('hex');
  const push = await wt.try(['push', `--force-with-lease=${branch}:${opts.payload.sourceSha}`, 'origin', `HEAD:${branch}`]);
  if (push.failed || push.exitCode !== 0) {
    return {
      kind: 'conflict-resolution',
      summary: 'Automatic conflict resolution escalated: branch changed before push',
      taskId: opts.payload.taskId,
      branch,
      resolved: false,
      rationale: resolution.rationale,
      resolvedPaths: resolution.resolvedPaths,
      checks,
      error: 'Force-with-lease rejected the resolved branch',
    };
  }
  return {
    kind: 'conflict-resolution',
    summary: resolution.summary,
    taskId: opts.payload.taskId,
    branch,
    resolved: true,
    rationale: resolution.rationale,
    resolvedPaths: resolution.resolvedPaths,
    checks,
    resolutionCommit: head,
    resolutionDiffHash,
  };
}

function conflictPrompt(payload: ResolveRebaseConflictJobPayload): string {
  return `You are resolving a stacked pull-request rebase conflict for task ${payload.context.task_key}: "${payload.context.task_title}".

The rebase of ${payload.branch} (${payload.sourceSha}) onto ${payload.baseBranch} (${payload.targetSha}) is paused with conflicts in exactly these files:
${payload.conflictedPaths.map((file) => `- ${file}`).join('\n')}

Resolve only those files. Preserve the intent of both the approved task plan and the earlier stacked changes. Do not run git commands, stage files, continue/abort the rebase, commit, push, or edit any other path; the worker performs and validates those operations.

Preserve Domain Driven Design boundaries while resolving conflicts: keep business invariants and domain vocabulary intact, keep domain dependencies independent of UI and infrastructure SDKs, and preserve use-case/port/adapter contracts from both changes. Do not introduce unrelated refactors; if the conflict cannot preserve these boundaries within the allowed paths, report resolved: false for human review.

Task description:
${payload.context.task_description}

Approved plan:
${payload.context.plan}

Earlier subtask outcomes:
${payload.context.sibling_summaries}`;
}

export function isProtectedPath(file: string, patterns: string[]): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  return patterns.some((pattern) => {
    const p = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
    if (p.endsWith('/')) return normalized.startsWith(p);
    return normalized === p || normalized.endsWith(`/${p}`);
  });
}

function isSafeRelativePath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return normalized.length > 0 && !path.isAbsolute(normalized) && !normalized.startsWith('/') && !normalized.split('/').includes('..') && !normalized.includes('\0');
}

function parseNul(output: string): string[] {
  return [...new Set(output.split('\0').map((value) => value.trim()).filter(Boolean))];
}

async function changedPaths(wt: ReturnType<GitFactory>): Promise<string[]> {
  const status = await wt(['status', '--porcelain=v1', '-z']);
  return parseNul(status.stdout).map((entry) => entry.slice(3)).filter(Boolean);
}

function parseNumstat(output: string): number {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => {
      const [added, removed] = line.split('\t');
      const a = Number(added);
      const r = Number(removed);
      return sum + (Number.isFinite(a) ? a : 0) + (Number.isFinite(r) ? r : 0);
    }, 0);
}

async function detectValidationCommands(cwd: string): Promise<string[][]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { packageManager?: unknown; scripts?: Record<string, unknown> };
    const manager = typeof raw.packageManager === 'string' ? raw.packageManager.split('@')[0] : 'npm';
    const scripts = raw.scripts ?? {};
    return ['typecheck', 'test', 'lint', 'build'].filter((name) => typeof scripts[name] === 'string').map((name) => [manager || 'npm', 'run', name]);
  } catch {
    return [];
  }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export type CommandRunner = (file: string, args: readonly string[], opts?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<RunResult>;
