import { randomUUID } from 'node:crypto';
import { WORKER_PROTOCOL_VERSION, type JobDispatch } from '@sindral/shared';
import { describe, expect, it, vi } from 'vitest';
import { WorkerAuthError, WorkerProtocolError } from './api.js';
import { silentLogger } from './logger.js';
import { Runner, taskKeysOf, type RunnerDeps } from './runner.js';
import { dispatch, testConfig } from './test/fixtures.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

interface Harness {
  runner: Runner;
  api: RunnerDeps['api'] & { failed: { jobId: string; error: string }[]; claims: number };
  release: (jobId: string) => void;
  started: string[];
  finished: string[];
  aborted: string[];
  concurrent: () => number;
  maxConcurrent: () => number;
}

function harness(batches: JobDispatch[][], overrides: Partial<RunnerDeps> = {}): Harness {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const finished: string[] = [];
  const aborted: string[] = [];
  let running = 0;
  let max = 0;
  const failed: { jobId: string; error: string }[] = [];
  const api = {
    claims: 0,
    failed,
    register: vi.fn(async () => ({ workerId: randomUUID(), protocolVersion: WORKER_PROTOCOL_VERSION })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    disconnect: vi.fn(async () => ({ ok: true as const })),
    claim: vi.fn(async (_body: { workerId: string; max: number }, signal?: AbortSignal) => {
      api.claims++;
      const batch = batches.shift();
      if (batch) return batch;
      // Emulate the server long-poll: wait until aborted or a short delay.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (signal?.aborted) throw new Error('aborted');
      return [];
    }),
    fail: vi.fn(async (jobId: string, error: string) => {
      failed.push({ jobId, error });
      return { ok: true as const };
    }),
  };
  const runner = new Runner({
    config: testConfig({ concurrency: 2 }),
    api,
    logger: silentLogger(),
    version: 'worker/test',
    hostname: 'h',
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    heartbeatIntervalMs: 1_000_000,
    shutdownGraceMs: 20,
    claimErrorBackoffMs: 1,
    runJob: (d, signal) =>
      new Promise<void>((resolve) => {
        started.push(d.job.id);
        running++;
        max = Math.max(max, running);
        const done = () => {
          running--;
          finished.push(d.job.id);
          resolve();
        };
        releases.set(d.job.id, done);
        signal.addEventListener('abort', () => {
          aborted.push(d.job.id);
          done();
        });
      }),
    ...overrides,
  });
  return {
    runner,
    api,
    release: (id) => releases.get(id)?.(),
    started,
    finished,
    aborted,
    concurrent: () => running,
    maxConcurrent: () => max,
  };
}

describe('Runner', () => {
  it('registers with the persisted worker id and saves the returned one', async () => {
    const persistence = { loadWorkerId: vi.fn(async () => 'old-id'), saveWorkerId: vi.fn(async () => {}), saveRunning: vi.fn(async () => {}) };
    const h = harness([], { persistence });
    const run = h.runner.start();
    await tick();
    await h.runner.stop();
    await run;
    expect(h.api.register).toHaveBeenCalledWith({ name: 'test-worker', hostname: 'h', version: 'worker/test', workerId: 'old-id' });
    expect(persistence.saveWorkerId).toHaveBeenCalledTimes(1);
    expect(h.api.disconnect).toHaveBeenCalledWith({ workerId: expect.any(String) });
  });

  it('fails before persistence or claiming when the server reports another protocol', async () => {
    const persistence = { loadWorkerId: vi.fn(async () => null), saveWorkerId: vi.fn(async () => {}), saveRunning: vi.fn(async () => {}) };
    const api = {
      register: vi.fn(async () => ({ workerId: randomUUID(), protocolVersion: WORKER_PROTOCOL_VERSION + 1 })),
      heartbeat: vi.fn(async () => ({ ok: true as const })),
      disconnect: vi.fn(async () => ({ ok: true as const })),
      claim: vi.fn(async () => []),
      fail: vi.fn(async () => ({ ok: true as const })),
    };
    const h = harness([], { persistence, api });
    await expect(h.runner.start()).rejects.toBeInstanceOf(WorkerProtocolError);
    expect(persistence.saveWorkerId).not.toHaveBeenCalled();
    expect(api.claim).not.toHaveBeenCalled();
  });

  it('never exceeds the concurrency limit', async () => {
    const jobs = [dispatch(), dispatch(), dispatch()];
    const h = harness([jobs]);
    const run = h.runner.start();
    await tick();
    expect(h.started).toEqual([jobs[0]?.job.id, jobs[1]?.job.id]);
    expect(h.concurrent()).toBe(2);
    h.release(jobs[0]!.job.id);
    await tick();
    expect(h.started).toHaveLength(3);
    expect(h.maxConcurrent()).toBe(2);
    for (const j of jobs.slice(1)) h.release(j.job.id);
    await tick();
    await h.runner.stop();
    await run;
    expect(h.finished).toHaveLength(3);
    expect(h.api.failed).toHaveLength(0);
  });

  it('serialises jobs of the same task even with free slots', async () => {
    const taskId = randomUUID();
    const a = dispatch({ taskId });
    const b = dispatch({ taskId });
    const c = dispatch();
    const h = harness([[a, b, c]]);
    const run = h.runner.start();
    await tick();
    expect(h.started).toEqual([a.job.id, c.job.id]);
    h.release(c.job.id);
    await tick();
    expect(h.started).toEqual([a.job.id, c.job.id]);
    h.release(a.job.id);
    await tick();
    expect(h.started).toEqual([a.job.id, c.job.id, b.job.id]);
    h.release(b.job.id);
    await tick();
    await h.runner.stop();
    await run;
  });

  it('claims only as many jobs as there are free slots', async () => {
    const a = dispatch();
    const h = harness([[a]]);
    const run = h.runner.start();
    await tick();
    const claims = vi.mocked(h.api.claim).mock.calls;
    expect(claims[0]?.[0]).toMatchObject({ max: 2 });
    expect(claims[1]?.[0]).toMatchObject({ max: 1 });
    h.release(a.job.id);
    await h.runner.stop();
    await run;
  });

  it('heartbeats lease tokens for running and locally pending claims', async () => {
    const taskId = randomUUID();
    const a = dispatch({ taskId });
    const b = dispatch({ taskId });
    const h = harness([[a, b]], { heartbeatIntervalMs: 5 });
    const run = h.runner.start();
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(h.api.heartbeat).toHaveBeenCalledWith({
      workerId: expect.any(String),
      runningJobs: expect.arrayContaining([
        { jobId: a.job.id, leaseToken: a.lease.token },
        { jobId: b.job.id, leaseToken: b.lease.token },
      ]),
    });
    h.release(a.job.id);
    await tick();
    h.release(b.job.id);
    await h.runner.stop();
    await run;
  });

  it('keeps active leases alive and lets running jobs finish while draining', async () => {
    const job = dispatch();
    const h = harness([[job]], {
      heartbeatIntervalMs: 5,
      shutdownGraceMs: 100,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const run = h.runner.start();
    await tick();
    const heartbeatCount = vi.mocked(h.api.heartbeat).mock.calls.length;

    const stopping = h.runner.stop();
    await new Promise((resolve) => setTimeout(resolve, 12));

    expect(h.concurrent()).toBe(1);
    expect(h.aborted).toEqual([]);
    expect(vi.mocked(h.api.heartbeat).mock.calls.length).toBeGreaterThan(heartbeatCount);
    expect(h.api.heartbeat).toHaveBeenCalledWith({
      workerId: expect.any(String),
      runningJobs: [{ jobId: job.job.id, leaseToken: job.lease.token }],
    });

    h.release(job.job.id);
    await stopping;
    await run;
    expect(h.finished).toEqual([job.job.id]);
    expect(h.aborted).toEqual([]);
  });

  it('on shutdown waits for the grace period, then aborts jobs and fails unstarted ones', async () => {
    const taskId = randomUUID();
    const a = dispatch({ taskId });
    const b = dispatch({ taskId });
    const h = harness([[a, b]]);
    const run = h.runner.start();
    await tick();
    expect(h.started).toEqual([a.job.id]);
    await h.runner.stop();
    await run;
    expect(h.finished).toEqual([a.job.id]);
    expect(h.aborted).toEqual([a.job.id]);
    expect(h.api.failed).toEqual([{ jobId: b.job.id, error: 'worker shutting down' }]);
  });

  it('exits when the worker key is rejected', async () => {
    const h = harness([], {
      api: {
        register: vi.fn(async () => ({ workerId: randomUUID(), protocolVersion: WORKER_PROTOCOL_VERSION })),
        heartbeat: vi.fn(async () => ({ ok: true as const })),
        disconnect: vi.fn(async () => ({ ok: true as const })),
        claim: vi.fn(async () => {
          throw new WorkerAuthError('bad key');
        }),
        fail: vi.fn(async () => ({ ok: true as const })),
      },
    });
    await expect(h.runner.start()).rejects.toBeInstanceOf(WorkerAuthError);
  });

  it('exits when a running server rejects the worker protocol', async () => {
    const api = {
      register: vi.fn(async () => ({ workerId: randomUUID(), protocolVersion: WORKER_PROTOCOL_VERSION })),
      heartbeat: vi.fn(async () => ({ ok: true as const })),
      disconnect: vi.fn(async () => ({ ok: true as const })),
      claim: vi.fn(async () => {
        throw new WorkerProtocolError('upgrade required');
      }),
      fail: vi.fn(async () => ({ ok: true as const })),
    };
    const h = harness([], { api });
    await expect(h.runner.start()).rejects.toBeInstanceOf(WorkerProtocolError);
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after transient claim errors', async () => {
    let calls = 0;
    const a = dispatch();
    const h = harness([], {
      api: {
        register: vi.fn(async () => ({ workerId: randomUUID(), protocolVersion: WORKER_PROTOCOL_VERSION })),
        heartbeat: vi.fn(async () => ({ ok: true as const })),
        disconnect: vi.fn(async () => ({ ok: true as const })),
        claim: vi.fn(async () => {
          calls++;
          if (calls === 1) throw new Error('503');
          if (calls === 2) return [a];
          await tick();
          return [];
        }),
        fail: vi.fn(async () => ({ ok: true as const })),
      },
    });
    const run = h.runner.start();
    await tick();
    await tick();
    await tick();
    expect(h.started).toEqual([a.job.id]);
    h.release(a.job.id);
    await h.runner.stop();
    await run;
  });

  it('derives task keys for the per-task guard and clean', () => {
    expect(taskKeysOf(dispatch())).toEqual(['ENG-142']);
    const rebase = dispatch({
      kind: 'rebase-stack',
      payload: { kind: 'rebase-stack', repos: ['a/b'], stack: [{ taskId: 't1', branch: 'x', baseBranch: 'main' }] },
    });
    expect(taskKeysOf(rebase)).toEqual(['rebase__t1']);
  });
});
