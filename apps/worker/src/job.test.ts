import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentResult } from '@sindral/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from './api.js';
import type { Engine, EngineRunOptions, EngineRunResult } from './engines/types.js';
import type { GhRunner } from './github.js';
import { runJob, type JobDeps } from './job.js';
import { silentLogger } from './logger.js';
import { agentPayload, dispatch, fakeGit, GH_TOKEN, ok, step, testConfig, WORKER_KEY } from './test/fixtures.js';
import type { Workspace, WorkspaceManager } from './workspace.js';

type EngineScript = (opts: EngineRunOptions) => Promise<Partial<EngineRunResult>>;

function fakeEngine(script: EngineScript, available = true): Engine & { runs: EngineRunOptions[] } {
  const runs: EngineRunOptions[] = [];
  return {
    name: 'claude',
    runs,
    probe: async () => ({ available, version: available ? '1.0.0' : null }),
    run: async (opts) => {
      runs.push(opts);
      const partial = await script(opts);
      return { exitCode: 0, tail: [], finalText: null, timedOut: false, cancelled: false, missing: false, ...partial };
    },
  };
}

function fakeApi() {
  const events: JobEvent[] = [];
  const completed: AgentResult[] = [];
  const failed: string[] = [];
  return {
    events,
    completed,
    failed,
    postEvent: vi.fn(async (_id: string, event: JobEvent) => {
      events.push(event);
      return { ok: true as const };
    }),
    complete: vi.fn(async (_id: string, result: AgentResult) => {
      completed.push(result);
      return { ok: true as const };
    }),
    fail: vi.fn(async (_id: string, error: string) => {
      failed.push(error);
      return { ok: true as const };
    }),
  };
}

describe('runJob', () => {
  let workdir: string;
  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-job-'));
  });
  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  function deps(engine: Engine, workspace: Workspace, extra: Partial<JobDeps> = {}) {
    const api = fakeApi();
    const workspaces = { workdir, prepare: vi.fn(async () => workspace), ensureRepo: vi.fn() } as unknown as WorkspaceManager;
    const d: JobDeps = {
      config: testConfig({ workdir }),
      api,
      engines: { claude: engine, codex: engine },
      workspaces,
      logger: silentLogger(),
      env: { PATH: '/bin', GH_TOKEN: 'ghp_should_not_leak_into_agent_env_000000' },
      progressIntervalMs: 1_000_000,
      ...extra,
    };
    return { deps: d, api, workspaces };
  }

  const docWorkspace = (): Workspace => ({ taskKey: 'DOC-1', cwd: path.join(workdir, 'tmp', 'DOC-1'), repos: [] });

  it('runs a document step, merging declared artifacts with output-dir files', async () => {
    const engine = fakeEngine(async (opts) => {
      expect(opts.env['GH_TOKEN']).toBeUndefined();
      expect(opts.env['SINDRAL_WORKER_KEY']).toBeUndefined();
      expect(opts.env['SINDRAL_TASK_KEY']).toBe('DOC-1');
      expect(opts.prompt).toContain('Sindral protocol');
      expect(opts.prompt).toContain(opts.env['SINDRAL_RESULT_FILE']);
      const outputDir = opts.env['SINDRAL_OUTPUT_DIR']!;
      await fs.mkdir(path.join(outputDir, 'notes'), { recursive: true });
      await fs.writeFile(path.join(outputDir, 'notes', 'b.txt'), 'from disk');
      await fs.writeFile(path.join(outputDir, 'a.md'), 'disk version should lose');
      await fs.writeFile(path.join(outputDir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
      await fs.writeFile(opts.env['SINDRAL_RESULT_FILE']!, JSON.stringify({ summary: 'wrote docs', artifacts: [{ name: 'a.md', contentType: 'text/markdown', content: 'declared' }] }));
      opts.onOutput('working...');
      return {};
    });
    const d = dispatch({ payload: agentPayload({ repos: [], step: step({ output: 'document', tools: ['write_file'] }), context: { ...agentPayload().context, task_key: 'DOC-1' } }) }, null);
    const { deps: jobDeps, api } = deps(engine, docWorkspace());

    const outcome = await runJob(d, jobDeps, new AbortController().signal);
    expect(outcome.status).toBe('completed');
    expect(api.completed[0]).toEqual({
      kind: 'document',
      summary: 'wrote docs',
      artifacts: [
        { name: 'a.md', contentType: 'text/markdown', content: 'declared' },
        { name: 'notes__b.txt', contentType: 'text/plain', content: 'from disk' },
      ],
    });
    expect(api.events.some((e) => e.type === 'log' && e.message.includes('working...'))).toBe(true);
    expect(api.events.some((e) => e.type === 'progress')).toBe(true);
    const log = await fs.readFile(path.join(workdir, 'logs', `${d.job.id}.log`), 'utf8');
    expect(log).toContain('working...');
    expect(log).toContain('job completed');
  });

  it('reports a canonical-path violation without writing through an escaped log directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-log-escape-'));
    try {
      await fs.symlink(outside, path.join(workdir, 'logs'));
      const engine = fakeEngine(async () => ({ finalText: JSON.stringify({ kind: 'plan', summary: 'x', plan: '# Plan' }) }));
      const d = dispatch();
      const { deps: jobDeps, api } = deps(engine, docWorkspace());
      const outcome = await runJob(d, jobDeps, new AbortController().signal);
      expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/escapes worker root/) });
      expect(api.failed).toHaveLength(1);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('fails with the redacted output tail when the result file is missing', async () => {
    const engine = fakeEngine(async (opts) => {
      opts.onOutput(`leaked ${GH_TOKEN}`);
      return { exitCode: 1, tail: ['step one', `leaked ${GH_TOKEN}`, `key ${WORKER_KEY}`] };
    });
    const d = dispatch({ payload: agentPayload({ repos: [], step: step({ output: 'plan' }) }) });
    const { deps: jobDeps, api } = deps(engine, docWorkspace());
    const outcome = await runJob(d, jobDeps, new AbortController().signal);
    expect(outcome.status).toBe('failed');
    const error = api.failed[0] ?? '';
    expect(error).toContain('did not write the result file');
    expect(error).toContain('exited with code 1');
    expect(error).toContain('step one');
    expect(error).not.toContain(GH_TOKEN);
    expect(error).not.toContain(WORKER_KEY);
    expect(api.completed).toHaveLength(0);
    const log = await fs.readFile(path.join(workdir, 'logs', `${d.job.id}.log`), 'utf8');
    expect(log).not.toContain(GH_TOKEN);
  });

  it('falls back to JSON in the final message when the result file is missing', async () => {
    const engine = fakeEngine(async (opts) => {
      expect(opts.writableDirs).toEqual([path.join(workdir, 'results'), opts.env['SINDRAL_OUTPUT_DIR']]);
      return { finalText: 'I cannot write files in plan mode, so here is the result:\n```json\n{"summary":"planned","plan":"# Plan"}\n```' };
    });
    const d = dispatch({ payload: agentPayload({ repos: [], step: step({ output: 'plan', permissions: ['read'] }) }) });
    const { deps: jobDeps, api } = deps(engine, docWorkspace());
    const outcome = await runJob(d, jobDeps, new AbortController().signal);
    expect(outcome).toEqual({ status: 'completed', result: { kind: 'plan', summary: 'planned', plan: '# Plan' } });
    expect(api.failed).toHaveLength(0);
  });

  it('fails when the result does not match the schema', async () => {
    const engine = fakeEngine(async (opts) => {
      await fs.writeFile(opts.env['SINDRAL_RESULT_FILE']!, JSON.stringify({ summary: 's', verdict: 'MAYBE' }));
      return { tail: ['last line'] };
    });
    const d = dispatch({ payload: agentPayload({ repos: [], step: step({ output: 'verdict' }) }) });
    const { deps: jobDeps, api } = deps(engine, docWorkspace());
    await runJob(d, jobDeps, new AbortController().signal);
    expect(api.failed[0]).toMatch(/does not match the expected shape/);
    expect(api.failed[0]).toContain('last line');
  });

  it('fails clearly when the required engine is missing or the step has no output', async () => {
    const missing = fakeEngine(async () => ({}), false);
    const d = dispatch({ payload: agentPayload({ repos: [] }) });
    const { deps: jobDeps, api } = deps(missing, docWorkspace());
    await runJob(d, jobDeps, new AbortController().signal);
    expect(api.failed[0]).toMatch(/Engine "claude".*cannot find or run/);
    expect(api.failed[0]).toContain('SINDRAL_EXTRA_PATH');

    const engine = fakeEngine(async () => ({}));
    const d2 = dispatch({ payload: agentPayload({ repos: [], step: step({ output: undefined }) }) });
    const second = deps(engine, docWorkspace());
    await runJob(d2, second.deps, new AbortController().signal);
    expect(second.api.failed[0]).toMatch(/no output kind/);
    expect(engine.runs).toHaveLength(0);
  });

  it('runs a pr step: pushes, opens a PR and completes with the PR url', async () => {
    const wt = path.join(workdir, 'worktrees', 'ENG-142', 'widgets');
    const workspace: Workspace = {
      taskKey: 'ENG-142',
      cwd: wt,
      repos: [{ repo: { owner: 'acme', name: 'widgets', full: 'acme/widgets' }, repoDir: '/base', dir: wt, branch: 'sindral/eng-142', baseBranch: 'main', resumed: false }],
    };
    const engine = fakeEngine(async (opts) => {
      expect(opts.cwd).toBe(wt);
      await fs.writeFile(opts.env['SINDRAL_RESULT_FILE']!, JSON.stringify({
        motivation: '   ',
        assumptions: '- Limits are scoped per authenticated user.',
        summary: 'Implemented and tested a per-user limiter.',
      }));
      return {};
    });
    const git = fakeGit((args) => (args[0] === 'status' ? ok(' M a.ts') : undefined));
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push([...args]);
      if (args[1] === 'list') return ok('[]');
      if (args[1] === 'create') return ok('https://github.com/acme/widgets/pull/9');
      return ok();
    };
    const ghFactory = vi.fn(() => gh);
    const d = dispatch();
    const { deps: jobDeps, api } = deps(engine, workspace, { git: git.factory, gh: ghFactory });
    const outcome = await runJob(d, jobDeps, new AbortController().signal);

    expect(outcome).toEqual({
      status: 'completed',
      result: {
        kind: 'pr',
        summary: 'Implemented and tested a per-user limiter.',
        prUrl: 'https://github.com/acme/widgets/pull/9',
        branch: 'sindral/eng-142',
        pullRequests: [
          {
            repository: 'acme/widgets',
            prUrl: 'https://github.com/acme/widgets/pull/9',
            number: 9,
            branch: 'sindral/eng-142',
            baseBranch: 'main',
          },
        ],
      },
    });
    expect(ghFactory).toHaveBeenCalledWith(GH_TOKEN);
    expect(git.find('push', '--force-with-lease')).toHaveLength(1);
    expect(git.calls[0]?.auth.configArgs[1]).toContain('extraheader');
    expect(ghCalls.find((c) => c[1] === 'create')).toContain('ENG-142: Add rate limiting');
    const create = ghCalls.find((c) => c[1] === 'create');
    const body = create?.[create.indexOf('--body') + 1] ?? '';
    expect(body).toContain('## Motivation\n\nLimit requests per user.');
    expect(body).toContain('## Assumptions\n\n- Limits are scoped per authenticated user.');
    expect(body).toContain('## Outcomes\n\nImplemented and tested a per-user limiter.');
    expect(api.events.some((e) => e.type === 'message' && e.message.includes('pull/9'))).toBe(true);
  });

  it('reports "worker shutting down" when aborted', async () => {
    const engine = fakeEngine(async () => ({ cancelled: true }));
    const controller = new AbortController();
    const d = dispatch({ payload: agentPayload({ repos: [], step: step({ output: 'plan' }) }) });
    const { deps: jobDeps, api } = deps(engine, docWorkspace());
    controller.abort('worker shutting down');
    await runJob(d, jobDeps, controller.signal);
    expect(api.failed).toEqual(['worker shutting down']);
  });

  it('completes a rebase-stack job through the rebase runner', async () => {
    const git = fakeGit((args) => (args[0] === 'worktree' && args[1] === 'list' ? ok('') : undefined));
    const engine = fakeEngine(async () => ({}));
    const { deps: jobDeps, api, workspaces } = deps(engine, docWorkspace(), { git: git.factory });
    (workspaces.ensureRepo as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(path.join(workdir, 'repos', 'acme__widgets'));
    const d = dispatch({ kind: 'rebase-stack', payload: { kind: 'rebase-stack', repos: ['acme/widgets'], stack: [{ taskId: 't1', branch: 'sindral/eng-1', baseBranch: 'main' }] } });
    const outcome = await runJob(d, jobDeps, new AbortController().signal);
    expect(outcome.status).toBe('completed');
    expect(api.completed[0]).toMatchObject({ kind: 'rebase', rebased: [{ taskId: 't1', ok: true }] });
    expect(engine.runs).toHaveLength(0);
  });
});
