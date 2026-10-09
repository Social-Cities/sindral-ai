import { randomUUID } from 'node:crypto';
import type { AgentJobPayload, Job, JobContext, JobDispatch, WorkflowStep } from '@sindral/shared';
import type { WorkerConfig } from '../config.js';
import type { GitAuth, GitRunner } from '../git.js';
import type { RunOptions, RunResult } from '../proc.js';

export const WORKER_KEY = ['sk', 'sindral', 'a'.repeat(40)].join('_');
export const GH_TOKEN = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_');

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    serverUrl: 'http://localhost:8787',
    workerKey: WORKER_KEY,
    workdir: '/tmp/sindral-test',
    concurrency: 2,
    workerName: 'test-worker',
    claudeBin: 'claude',
    codexBin: 'codex',
    ghBin: 'gh',
    jobTimeoutMs: 60_000,
    retentionMs: 7 * 24 * 60 * 60_000,
    allowPatMerge: true,
    publishChecks: [],
    publishCheckMode: 'off',
    publishCheckTimeoutMs: 30 * 60_000,
    logLevel: 'silent',
    ...overrides,
  };
}

export function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    task_key: 'ENG-142',
    task_title: 'Add rate limiting',
    task_description: 'Limit requests per user.',
    task_outcome: 'Requests are limited per user.',
    acceptance_criteria: '- Requests above the limit are rejected.',
    plan: '',
    feedback: '',
    pr_url: '',
    parent_plan: '',
    sibling_summaries: '',
    review_slices: '',
    review: '',
    verify_report: '',
    error: '',
    ...overrides,
  };
}

export function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'implement',
    type: 'agent',
    label: 'Implement',
    state: 'implement',
    engine: 'claude',
    model: 'claude-sonnet-4-5',
    mode: 'normal',
    prompt: 'Implement {{task_key}}: {{task_title}}\n\n{{task_description}}',
    tools: ['read_file', 'write_file', 'run_command', 'search_codebase', 'list_directory'],
    permissions: ['read', 'write', 'execute'],
    output: 'pr',
    ...overrides,
  };
}

export function agentPayload(overrides: Partial<AgentJobPayload> = {}): AgentJobPayload {
  return { kind: 'agent', step: step(), context: context(), repos: ['acme/widgets'], branch: null, baseBranch: null, prUrl: null, ...overrides };
}

export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    taskId: randomUUID(),
    kind: 'agent',
    stepId: 'implement',
    status: 'claimed',
    workerId: null,
    attempt: 1,
    payload: agentPayload(),
    result: null,
    error: null,
    outcomeHash: null,
    outcomeToken: null,
    outcomeStartedAt: null,
    dedupeKey: null,
    createdAt: new Date().toISOString(),
    claimedAt: null,
    leaseExpiresAt: null,
    finishedAt: null,
    ...overrides,
  };
}

export function dispatch(jobOverrides: Partial<Job> = {}, githubToken: string | null = GH_TOKEN): JobDispatch {
  return {
    job: job(jobOverrides),
    lease: { token: '10000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 90_000).toISOString() },
    credentials: { githubToken, githubCredential: githubToken ? 'pat' : null },
  };
}

export function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', failed: false, timedOut: false, cancelled: false, code: null, message: '' };
}

export function failed(stderr = 'boom', exitCode = 1): RunResult {
  return { exitCode, stdout: '', stderr, failed: true, timedOut: false, cancelled: false, code: null, message: stderr };
}

export interface GitCall {
  cwd: string;
  args: string[];
  auth: GitAuth;
}

/**
 * A fake git: `respond` maps a joined-args prefix to a result. Anything
 * unmatched succeeds with empty output. Records every call.
 */
export function fakeGit(respond: (args: string[], cwd: string) => RunResult | undefined = () => undefined) {
  const calls: GitCall[] = [];
  const factory = (cwd: string, auth: GitAuth): GitRunner => {
    const exec = async (args: readonly string[], _opts?: RunOptions): Promise<RunResult> => {
      const list = [...args];
      calls.push({ cwd, args: list, auth });
      return respond(list, cwd) ?? ok();
    };
    const runner = (async (args: readonly string[], opts?: RunOptions) => {
      const res = await exec(args, opts);
      if (res.failed || res.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      return res;
    }) as GitRunner;
    runner.try = exec;
    return runner;
  };
  return { factory, calls, find: (...prefix: string[]) => calls.filter((c) => prefix.every((p, i) => c.args[i] === p)) };
}
