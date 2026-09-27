import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_PROTOCOL_HEADER, WORKER_PROTOCOL_VERSION, type Task, type WorkflowRecord } from '@sindral/shared';
import { claimNext, completeMerge, completeNext, createTestApp, plan, pr, review, testConfig, verdict, type TestContext } from '../test/helpers.js';

const fetchMock = vi.fn<typeof fetch>();
let ctx: TestContext;

beforeEach(async () => {
  fetchMock.mockReset();
  ctx = await createTestApp({ fetch: fetchMock });
});
afterEach(async () => {
  await ctx.app.close();
});

const asA = () => ({ authorization: `Bearer ${ctx.tokenA}` });
const asB = () => ({ authorization: `Bearer ${ctx.tokenB}` });
let actionSequence = 0;

async function taskAction(taskId: string, event: string, headers = asA()) {
  actionSequence += 1;
  const current = await ctx.repo.getTask(ctx.userA, taskId);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/actions`,
    headers: { ...headers, 'idempotency-key': `route-test-${actionSequence}` },
    payload: { event, expectedVersion: current?.version ?? 0 },
  });
}

async function createTask(headers = asA(), payload: Record<string, unknown> = { title: 'Task', repos: ['acme/app'] }): Promise<Task> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers, payload });
  expect(res.statusCode).toBe(201);
  return res.json<{ task: Task }>().task;
}

describe('tasks API', () => {
  it('validates bodies, params and queries', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: asA(), payload: { title: '' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: asA(), payload: { title: 'x', repos: ['not a repo'] } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: asA(), payload: { title: 'x', key: 'lower-1' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/tasks/not-a-uuid', headers: asA() })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/tasks?parentTaskId=abc', headers: asA() })).statusCode).toBe(400);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...asA(), 'content-type': 'application/json' }, payload: '{nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBeTruthy();
    expect((await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...asA(), 'content-type': 'application/xml' }, payload: '<x/>' })).statusCode).toBe(415);
  });

  it('never leaks stack traces', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/tasks/not-a-uuid', headers: asA() });
    expect(res.body).not.toContain('at ');
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } });
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/nothing', headers: asA() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('isolates users from each other', async () => {
    const task = await createTask();
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: asA() })).statusCode).toBe(200);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const res = await ctx.app.inject({ method, url: `/api/tasks/${task.id}`, headers: asB(), payload: method === 'PATCH' ? { title: 'pwned' } : undefined });
      expect(res.statusCode, method).toBe(404);
    }
    expect((await taskAction(task.id, 'start', asB())).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/messages`, headers: asB(), payload: { content: 'hi' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/jobs`, headers: asB() })).statusCode).toBe(404);
    const listB = await ctx.app.inject({ method: 'GET', url: '/api/tasks', headers: asB() });
    expect(listB.json()).toEqual({ tasks: [] });
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.title).toBe('Task');
  });

  it('returns 409 for invalid transitions and 404 for unknown tasks', async () => {
    const task = await createTask();
    const res = await taskAction(task.id, 'approve');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_TRANSITION' } });
    expect((await taskAction(task.id, 'Bad Event')).statusCode).toBe(400);
    const ok = await taskAction(task.id, 'start');
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ task: Task }>().task.state).toBe('planning');
    expect((await taskAction('00000000-0000-4000-8000-000000000000', 'start')).statusCode).toBe(404);
  });

  it('marks tasks done or wont-do through audited actions and cancels queued work', async () => {
    const wontDoTask = await createTask();
    await taskAction(wontDoTask.id, 'start');
    const closed = await taskAction(wontDoTask.id, 'mark-wont-do');
    expect(closed.statusCode).toBe(200);
    expect(closed.json<{ task: Task }>().task.state).toBe('wont-do');
    expect((await ctx.repo.listJobsForTask(ctx.userA, wontDoTask.id))[0]?.status).toBe('cancelled');
    expect((await ctx.repo.listEvents(ctx.userA, wontDoTask.id)).at(-1)).toMatchObject({
      type: 'transition',
      fromState: 'planning',
      toState: 'wont-do',
      detail: { event: 'mark-wont-do', actor: 'user' },
    });
    expect((await taskAction(wontDoTask.id, 'retry')).statusCode).toBe(409);

    const doneTask = await createTask();
    const done = await taskAction(doneTask.id, 'mark-done');
    expect(done.statusCode).toBe(200);
    expect(done.json<{ task: Task }>().task).toMatchObject({ state: 'done', currentStepId: 'done' });
  });

  it('makes versioned task actions idempotent and rejects stale concurrent actions', async () => {
    const task = await createTask();
    const url = `/api/tasks/${task.id}/actions`;
    const payload = { event: 'start', expectedVersion: task.version };
    const missingKey = await ctx.app.inject({ method: 'POST', url, headers: asA(), payload });
    expect(missingKey.statusCode).toBe(400);

    const headers = { ...asA(), 'idempotency-key': 'same-command-key' };
    const first = await ctx.app.inject({ method: 'POST', url, headers, payload });
    const replay = await ctx.app.inject({ method: 'POST', url, headers, payload });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ task: Task }>().task).toEqual(first.json<{ task: Task }>().task);
    expect(await ctx.repo.listJobsForTask(ctx.userA, task.id)).toHaveLength(1);
    expect((await ctx.repo.listEvents(ctx.userA, task.id)).filter((event) => event.type === 'transition')).toHaveLength(1);

    const reused = await ctx.app.inject({ method: 'POST', url, headers, payload: { event: 'retry', expectedVersion: task.version } });
    expect(reused.statusCode).toBe(409);
    const stale = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { ...asA(), 'idempotency-key': 'different-command-key' },
      payload,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('returns relations, lists with filters and patches with state guards', async () => {
    const task = await createTask();
    await createTask(asA(), { title: 'Other thing', repos: [] });
    await taskAction(task.id, 'start');
    await ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/messages`, headers: asA(), payload: { content: 'note' } });

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: asA() });
    const body = detail.json<{ task: Task & { messages: unknown[]; events: unknown[]; artifacts: unknown[]; subtasks: unknown[] } }>().task;
    expect(body.messages).toHaveLength(1);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.artifacts).toEqual([]);
    expect(body.subtasks).toEqual([]);

    const planning = await ctx.app.inject({ method: 'GET', url: '/api/tasks?state=planning', headers: asA() });
    expect(planning.json<{ tasks: Task[] }>().tasks.map((t) => t.id)).toEqual([task.id]);
    const search = await ctx.app.inject({ method: 'GET', url: '/api/tasks?search=other', headers: asA() });
    expect(search.json<{ tasks: Task[] }>().tasks.map((t) => t.title)).toEqual(['Other thing']);
    const byKey = await ctx.app.inject({ method: 'GET', url: '/api/tasks?search=sin-1', headers: asA() });
    expect(byKey.json<{ tasks: Task[] }>().tasks.map((t) => t.id)).toEqual([task.id]);

    const patchRepos = await ctx.app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: asA(), payload: { repos: ['acme/other'] } });
    expect(patchRepos.statusCode).toBe(409);
    const patchTitle = await ctx.app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: asA(), payload: { title: 'Renamed', state: 'done' } });
    expect(patchTitle.statusCode).toBe(200);
    expect(patchTitle.json<{ task: Task }>().task).toMatchObject({ title: 'Renamed', state: 'planning' });

    const jobs = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/jobs`, headers: asA() });
    const [job] = jobs.json<{ jobs: { id: string; status: string }[] }>().jobs;
    expect(job?.status).toBe('queued');
    const logs = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${job!.id}/logs`, headers: asA() });
    expect(logs.json()).toEqual({ logs: [] });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/jobs/${job!.id}/logs`, headers: asB() })).statusCode).toBe(404);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers: asA() });
    expect(del.json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: asA() })).statusCode).toBe(404);
  });

  it('serves PR diffs from GitHub with the stored token', async () => {
    const task = await createTask();
    const empty = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/diff`, headers: asA() });
    expect(empty.json()).toEqual({ files: [] });
    await ctx.repo.updateTask(ctx.userA, task.id, { prUrl: 'https://github.com/acme/app/pull/12' });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/diff`, headers: asA() })).statusCode).toBe(400);
    await ctx.app.ctx.secrets.set(ctx.userA, 'github', 'ghp_tokentoken');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 2, patch: '@@' }, { filename: 'b.png', status: 'added', additions: 0, deletions: 0 }])));
    const res = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/diff`, headers: asA() });
    expect(res.json()).toEqual({ files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 2, patch: '@@' }, { filename: 'b.png', status: 'added', additions: 0, deletions: 0 }] });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/app/pulls/12/files?per_page=100&page=1');
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe('Bearer ghp_tokentoken');
    await ctx.repo.updateTask(ctx.userA, task.id, { prUrl: 'https://gitlab.com/acme/app/-/merge_requests/1' });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/diff`, headers: asA() })).json()).toEqual({ files: [] });
  });
});

describe('workflows API', () => {
  it('seeds bundled workflows per user and validates updates', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/workflows', headers: asA() });
    const workflows = list.json<{ workflows: WorkflowRecord[] }>().workflows;
    expect(workflows.map((w) => w.name)).toEqual(['Full SDLC', 'Planning Only', 'Fast Track', 'Document (non-code)']);
    expect(workflows[0]!.isDefault).toBe(true);
    expect(workflows[0]!.userId).toBe(ctx.userA);
    const listB = await ctx.app.inject({ method: 'GET', url: '/api/workflows', headers: asB() });
    expect(listB.json<{ workflows: WorkflowRecord[] }>().workflows[0]!.id).not.toBe(workflows[0]!.id);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/workflows/${workflows[0]!.id}`, headers: asB() })).statusCode).toBe(404);

    const created = await ctx.app.inject({ method: 'POST', url: '/api/workflows', headers: asA(), payload: { name: 'Custom', cloneFrom: workflows[2]!.id } });
    expect(created.statusCode).toBe(201);
    const custom = created.json<{ workflow: WorkflowRecord }>().workflow;
    expect(custom.name).toBe('Custom');
    expect(custom.entryStepId).toBe('todo');

    const { id: _id, userId: _u, isDefault: _d, createdAt: _c, updatedAt: _up, ...definition } = custom;
    const bad = await ctx.app.inject({ method: 'PUT', url: `/api/workflows/${custom.id}`, headers: asA(), payload: { ...definition, edges: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'INVALID_WORKFLOW' } });
    expect((bad.json() as { error: { details: unknown[] } }).error.details.length).toBeGreaterThan(0);
    const schemaBad = await ctx.app.inject({ method: 'PUT', url: `/api/workflows/${custom.id}`, headers: asA(), payload: { ...definition, steps: [{ id: 'bad id!' }] } });
    expect(schemaBad.statusCode).toBe(400);
    const good = await ctx.app.inject({ method: 'PUT', url: `/api/workflows/${custom.id}`, headers: asA(), payload: { ...definition, name: 'Custom v2' } });
    expect(good.statusCode).toBe(200);
    expect(good.json<{ workflow: WorkflowRecord }>().workflow.name).toBe('Custom v2');
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/workflows/${custom.id}`, headers: asB(), payload: definition })).statusCode).toBe(404);

    const task = await createTask(asA(), { title: 'pinned', workflowId: custom.id });
    await taskAction(task.id, 'start');
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/workflows/${custom.id}`, headers: asA() })).json()).toEqual({ ok: true });
    const fresh = await ctx.repo.getTask(ctx.userA, task.id);
    expect(fresh?.workflowId).toBeNull();
    expect(fresh?.pinnedWorkflow?.name).toBe('Custom v2');
  });
});

describe('worker API', () => {
  async function registeredWorker() {
    const key = await ctx.workerKeyFor(ctx.userA);
    const headers = { authorization: `Bearer ${key}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION) };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/worker/register', headers, payload: { name: 'mac', hostname: 'mac.local', version: '0.1.0' } });
    return { headers, workerId: res.json<{ workerId: string }>().workerId };
  }

  it('rejects missing and incompatible worker protocols before mutating state', async () => {
    const key = await ctx.workerKeyFor(ctx.userA);
    const request = (protocol?: string) => ctx.app.inject({
      method: 'POST',
      url: '/api/worker/register',
      headers: { authorization: `Bearer ${key}`, ...(protocol ? { [WORKER_PROTOCOL_HEADER]: protocol } : {}) },
      payload: { name: 'old-worker', hostname: 'old.local', version: '0.0.1' },
    });

    const missing = await request();
    expect(missing.statusCode).toBe(426);
    expect(missing.headers.upgrade).toBe(`sindral-worker/${WORKER_PROTOCOL_VERSION}`);
    expect(missing.json()).toMatchObject({
      error: {
        code: 'WORKER_PROTOCOL_MISMATCH',
        details: { clientProtocolVersion: null, serverProtocolVersion: WORKER_PROTOCOL_VERSION },
      },
    });
    const incompatible = await request(String(WORKER_PROTOCOL_VERSION + 1));
    expect(incompatible.statusCode).toBe(426);
    expect(incompatible.headers.upgrade).toBe(`sindral-worker/${WORKER_PROTOCOL_VERSION}`);
    expect(incompatible.json()).toMatchObject({ error: { code: 'WORKER_PROTOCOL_MISMATCH' } });
    expect(await ctx.repo.listWorkers(ctx.userA)).toEqual([]);

    const staleWorker = await ctx.repo.createWorker(ctx.userA, { name: 'stale', hostname: 'old.local', version: '0.0.1', workerKeyId: null });
    const task = await createTask();
    await taskAction(task.id, 'start');
    const staleClaim = await ctx.app.inject({
      method: 'POST',
      url: '/api/worker/jobs/claim',
      headers: { authorization: `Bearer ${key}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION + 1) },
      payload: { workerId: staleWorker.id },
    });
    expect(staleClaim.statusCode).toBe(426);
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id))[0]?.status).toBe('queued');
  });

  it('runs a job end to end: register, claim (long poll), events, complete', async () => {
    const { headers, workerId } = await registeredWorker();
    const again = await ctx.app.inject({ method: 'POST', url: '/api/worker/register', headers, payload: { name: 'mac2', hostname: 'mac.local', version: '0.2.0', workerId } });
    expect(again.json()).toEqual({ workerId, protocolVersion: WORKER_PROTOCOL_VERSION });
    expect((await ctx.repo.listWorkers(ctx.userA)).map((w) => w.name)).toEqual(['mac2']);

    const empty = await ctx.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers, payload: { workerId, max: 2 } });
    expect(empty.json()).toEqual({ jobs: [] });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/worker/heartbeat', headers, payload: { workerId, runningJobs: [] } })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/worker/heartbeat', headers, payload: { workerId: '00000000-0000-4000-8000-000000000000', runningJobs: [] } })).statusCode).toBe(404);

    await ctx.app.ctx.secrets.set(ctx.userA, 'github', 'ghp_workertoken');
    const task = await createTask();
    await taskAction(task.id, 'start');
    const claim = await ctx.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers, payload: { workerId } });
    const { jobs } = claim.json<{ jobs: { job: { id: string; status: string; payload: { step: { id: string } } }; lease: { token: string; expiresAt: string }; credentials: { githubToken: string | null } }[] }>();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.status).toBe('claimed');
    expect(jobs[0]!.job.payload.step.id).toBe('planning');
    expect(jobs[0]!.credentials.githubToken).toBe('ghp_workertoken');
    const jobId = jobs[0]!.job.id;
    const leaseToken = jobs[0]!.lease.token;
    expect(leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(jobs[0]!.job).not.toHaveProperty('leaseToken');

    expect((await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/events`, headers, payload: { type: 'log', message: 'booting', attempt: 1, leaseToken } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/events`, headers, payload: { type: 'message', message: 'Working on it', attempt: 1, leaseToken } })).statusCode).toBe(200);
    expect((await ctx.repo.getJob(ctx.userA, jobId))?.status).toBe('running');
    const logs = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}/logs`, headers: asA() });
    expect(logs.json<{ logs: { type: string; message: string }[] }>().logs.map((l) => l.message)).toEqual(['booting', 'Working on it']);
    expect((await ctx.repo.listMessages(ctx.userA, task.id)).map((m) => m.content)).toEqual(['Working on it']);

    expect((await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/complete`, headers, payload: { result: { kind: 'plan' } } })).statusCode).toBe(400);
    const wrongLease = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/complete`, headers, payload: { attempt: 1, leaseToken: '20000000-0000-4000-8000-000000000002', result: plan('# P') } });
    expect(wrongLease.statusCode).toBe(409);
    const done = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/complete`, headers, payload: { attempt: 1, leaseToken, result: plan('# P') } });
    expect(done.statusCode).toBe(200);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('plan-review');
    const metrics = await ctx.app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${ctx.config.metricsToken}` } });
    expect(metrics.body).toContain('sindral_job_claim_latency_seconds_count{kind="agent"} 1');
    expect(metrics.body).toContain('sindral_job_duration_seconds_count{kind="agent",outcome="completed"} 1');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/events`, headers, payload: { type: 'log', message: 'late', attempt: 1, leaseToken } })).statusCode).toBe(409);
  });

  it('reports cleanup guards and marks a graceful worker disconnect offline', async () => {
    const { headers, workerId } = await registeredWorker();
    const online = await ctx.app.inject({ method: 'POST', url: '/api/worker/cleanup-status', headers, payload: { workerId } });
    expect(online.json()).toEqual({ workerOnline: true, activeJobs: [] });

    expect((await ctx.app.inject({ method: 'POST', url: '/api/worker/disconnect', headers, payload: { workerId } })).json()).toEqual({ ok: true });
    const offline = await ctx.app.inject({ method: 'POST', url: '/api/worker/cleanup-status', headers, payload: { workerId } });
    expect(offline.json()).toEqual({ workerOnline: false, activeJobs: [] });

    const task = await createTask();
    await taskAction(task.id, 'start');
    const claim = await ctx.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers, payload: { workerId } });
    const jobId = claim.json<{ jobs: { job: { id: string } }[] }>().jobs[0]!.job.id;
    const guarded = await ctx.app.inject({ method: 'POST', url: '/api/worker/cleanup-status', headers, payload: { workerId } });
    expect(guarded.json()).toEqual({ workerOnline: true, activeJobs: [{ jobId, taskKey: task.key }] });
  });

  it('long-polls until a job appears', async () => {
    const slow = await createTestApp({ claim: { waitMs: 1500, pollMs: 20 } });
    try {
      const key = await slow.workerKeyFor(slow.userA);
      const headers = { authorization: `Bearer ${key}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION) };
      const reg = await slow.app.inject({ method: 'POST', url: '/api/worker/register', headers, payload: { name: 'w', hostname: 'h', version: '1' } });
      const { workerId } = reg.json<{ workerId: string }>();
      const pending = slow.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers, payload: { workerId } });
      const task = await slow.app.ctx.orchestrator.createTask(slow.userA, { title: 't', description: '', repos: [] });
      setTimeout(() => void slow.app.ctx.orchestrator.applyUserEvent(slow.userA, task.id, 'start'), 60);
      const res = await pending;
      expect(res.json<{ jobs: unknown[] }>().jobs).toHaveLength(1);
    } finally {
      await slow.app.close();
    }
  });

  it('keeps queued work untouched while worker dispatch is disabled', async () => {
    const paused = await createTestApp({ config: testConfig({ jobDispatchEnabled: false }) });
    try {
      const task = await paused.app.ctx.orchestrator.createTask(paused.userA, { title: 'paused', description: '', repos: [] });
      await paused.app.ctx.orchestrator.applyUserEvent(paused.userA, task.id, 'start');
      const key = await paused.workerKeyFor(paused.userA);
      const headers = { authorization: `Bearer ${key}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION) };
      const registered = await paused.app.inject({ method: 'POST', url: '/api/worker/register', headers, payload: { name: 'w', hostname: 'h', version: '1' } });
      const { workerId } = registered.json<{ workerId: string }>();
      const claim = await paused.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers, payload: { workerId } });
      expect(claim.json()).toEqual({ jobs: [] });
      expect((await paused.repo.listJobsForTask(paused.userA, task.id))[0]?.status).toBe('queued');
    } finally {
      await paused.app.close();
    }
  });

  it('fails a job and cannot touch another user’s jobs', async () => {
    const { headers, workerId } = await registeredWorker();
    const task = await createTask();
    await taskAction(task.id, 'start');
    const claim = await ctx.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers, payload: { workerId } });
    const claimed = claim.json<{ jobs: { job: { id: string }; lease: { token: string } }[] }>().jobs[0]!;
    const jobId = claimed.job.id;

    const otherKey = await ctx.workerKeyFor(ctx.userB);
    const otherHeaders = { authorization: `Bearer ${otherKey}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION) };
    expect((await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/fail`, headers: otherHeaders, payload: { attempt: 1, leaseToken: claimed.lease.token, error: 'x' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: otherHeaders, payload: { workerId } })).statusCode).toBe(404);

    const failed = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/fail`, headers, payload: { attempt: 1, leaseToken: claimed.lease.token, error: 'agent crashed' } });
    expect(failed.statusCode).toBe(200);
    const fresh = await ctx.repo.getTask(ctx.userA, task.id);
    expect(fresh).toMatchObject({ state: 'failure', lastError: 'agent crashed', failedStepId: 'planning' });
  });

  it('computes worker online status from last seen', async () => {
    const { workerId } = await registeredWorker();
    let res = await ctx.app.inject({ method: 'GET', url: '/api/workers', headers: asA() });
    expect(res.json<{ workers: { id: string; status: string }[] }>().workers).toEqual([expect.objectContaining({ id: workerId, status: 'online' })]);
    await ctx.repo.updateWorker(ctx.userA, workerId, { lastSeenAt: new Date(Date.now() - 120_000).toISOString() });
    res = await ctx.app.inject({ method: 'GET', url: '/api/workers', headers: asA() });
    expect(res.json<{ workers: { status: string }[] }>().workers[0]!.status).toBe('offline');
    await ctx.repo.updateWorker(ctx.userA, workerId, { status: 'offline', lastSeenAt: new Date().toISOString() });
    res = await ctx.app.inject({ method: 'GET', url: '/api/workers', headers: asA() });
    expect(res.json<{ workers: { status: string }[] }>().workers[0]!.status).toBe('offline');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/workers', headers: asB() })).json()).toEqual({ workers: [] });
  });
});

describe('settings API', () => {
  it('creates worker keys returning the secret once, lists and revokes', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/settings/worker-keys', headers: asA(), payload: { name: 'laptop' } });
    expect(created.statusCode).toBe(201);
    const { key, secret } = created.json<{ key: { id: string; keyPrefix: string; revokedAt: string | null }; secret: string }>();
    expect(secret).toMatch(/^sk_sindral_[0-9a-f]{40}$/);
    expect(key.keyPrefix).toBe(secret.slice(0, 18));
    expect(JSON.stringify(key)).not.toContain(secret);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/settings/worker-keys', headers: asA() });
    expect(list.json<{ keys: { id: string }[] }>().keys.map((k) => k.id)).toEqual([key.id]);
    expect(JSON.stringify(list.json())).not.toMatch(/keyHash|[0-9a-f]{64}/);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/settings/worker-keys/${key.id}`, headers: asB() })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/settings/worker-keys/${key.id}`, headers: asA() })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/worker/register', headers: { authorization: `Bearer ${secret}` }, payload: { name: 'w', hostname: 'h', version: '1' } })).statusCode).toBe(401);
  });

  it('stores provider secrets encrypted and reports status without the token', async () => {
    const initial = await ctx.app.inject({ method: 'GET', url: '/api/settings/secrets', headers: asA() });
    expect(initial.json()).toEqual({ secrets: [
      { provider: 'github', configured: false, updatedAt: null, hint: null },
      { provider: 'linear', configured: false, updatedAt: null, hint: null },
      { provider: 'jira', configured: false, updatedAt: null, hint: null },
    ] });
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings/secrets', headers: asA(), payload: { provider: 'jira', token: 'jira-token-1234' } })).statusCode).toBe(400);
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/settings/secrets', headers: asA(), payload: { provider: 'github', token: 'ghp_abcdefgh1234' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ secret: { provider: 'github', configured: true, hint: '1234' } });
    expect(put.body).not.toContain('ghp_abcdefgh1234');
    const stored = await ctx.repo.getSecret(ctx.userA, 'github');
    expect(stored?.ciphertext).not.toContain('ghp_');
    expect(await ctx.app.ctx.secrets.get(ctx.userA, 'github')).toEqual({ token: 'ghp_abcdefgh1234', metadata: {} });
    expect(await ctx.app.ctx.secrets.get(ctx.userB, 'github')).toBeNull();
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/settings/secrets/github', headers: asA() })).json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/settings/secrets/slack', headers: asA() })).statusCode).toBe(400);
    expect(await ctx.repo.getSecret(ctx.userA, 'github')).toBeNull();
  });
});

describe('server-sent events', () => {
  it('streams task events for the authenticated user only', async () => {
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const res = await fetch(`${address}/api/events`, { headers: asA(), signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (predicate: (s: string) => boolean): Promise<void> => {
      while (!predicate(buffer)) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value);
      }
    };
    await readUntil((s) => s.includes('"ping"'));
    ctx.app.ctx.hub.publish(ctx.userB, { type: 'task.created', taskId: 'other-user' });
    const task = await ctx.app.ctx.orchestrator.createTask(ctx.userA, { title: 't', description: '', repos: [] });
    await readUntil((s) => s.includes('task.created'));
    const frames = buffer.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')) as { type: string; taskId?: string });
    expect(frames[0]).toEqual({ type: 'ping' });
    expect(frames).toContainEqual({ type: 'task.created', taskId: task.id });
    expect(frames.some((f) => f.taskId === 'other-user')).toBe(false);
    expect(ctx.app.ctx.hub.subscriberCount(ctx.userA)).toBe(1);
    controller.abort();
    await vi.waitFor(() => expect(ctx.app.ctx.hub.subscriberCount(ctx.userA)).toBe(0));
  });

  it('sends CORS headers for allowed origins', async () => {
    const res = await ctx.app.inject({ method: 'OPTIONS', url: '/api/tasks', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect(denied.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

describe('operational metrics', () => {
  it('requires its dedicated bearer token and exposes aggregate state only', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(401);
    await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: asA(), payload: { title: '' } });
    await ctx.app.ctx.orchestrator.createTask(ctx.userA, { title: 'metric task', description: '', repos: [] });
    const response = await ctx.app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${ctx.config.metricsToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# TYPE sindral_tasks gauge');
    expect(response.body).toContain('sindral_tasks{state="todo"} 1');
    expect(response.body).toContain('sindral_validation_failures_total{surface="api"} 1');
    expect(response.body).toContain('sindral_workers 0');
    expect(response.body).not.toContain(ctx.userA);
  });
});

describe('static UI hosting', () => {
  it('serves files and falls back to index.html for non-API GETs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sindral-web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Sindral</title>');
    writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    const web = await createTestApp({ config: testConfig({ webDistDir: dir }), serveWeb: true });
    try {
      expect((await web.app.inject({ method: 'GET', url: '/app.js' })).body).toBe('console.log(1)');
      const spa = await web.app.inject({ method: 'GET', url: '/tasks/123' });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain('<title>Sindral</title>');
      const api = await web.app.inject({ method: 'GET', url: '/api/missing' });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect((await web.app.inject({ method: 'POST', url: '/tasks' })).statusCode).toBe(404);
    } finally {
      await web.app.close();
    }
  });
});

describe('end to end through HTTP', () => {
  it('drives a Fast Track task to done', async () => {
    const workflows = (await ctx.app.inject({ method: 'GET', url: '/api/workflows', headers: asA() })).json<{ workflows: WorkflowRecord[] }>().workflows;
    const fast = workflows.find((w) => w.name === 'Fast Track')!;
    const task = await createTask(asA(), { title: 'quick', repos: ['acme/app'], workflowId: fast.id });
    await taskAction(task.id, 'start');
    await completeNext(ctx, ctx.userA, pr(3));
    expect(await ctx.repo.getTask(ctx.userA, task.id)).toMatchObject({
      outcome: 'The requested behavior is delivered.',
      acceptanceCriteria: '- The requested behavior is verified.',
    });
    const verifyJob = await claimNext(ctx, ctx.userA);
    expect(verifyJob?.payload.kind).toBe('agent');
    if (!verifyJob || verifyJob.payload.kind !== 'agent') throw new Error('expected verify job');
    expect(verifyJob.payload.context.task_outcome).toBe('The requested behavior is delivered.');
    expect(verifyJob.payload.context.acceptance_criteria).toBe('- The requested behavior is verified.');
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, verifyJob.id, verdict(true), verifyJob.attempt, verifyJob.leaseToken);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('in-review');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/artifacts`, headers: asA() })).json<{ artifacts: { name: string }[] }>().artifacts.map((a) => a.name)).toEqual(['verify-report.md']);
    const accepted = await taskAction(task.id, 'accept');
    expect(accepted.json<{ task: Task }>().task.state).toBe('merge');
    await completeMerge(ctx, ctx.userA);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('done');
    void review;
  });

  it('rejects automatic merge before changing state when the kill switch is off', async () => {
    const guarded = await createTestApp({ config: testConfig({ autoMergeEnabled: false }) });
    try {
      const fast = (await guarded.app.ctx.workflows.list(guarded.userA)).find((workflow) => workflow.name === 'Fast Track')!;
      let task = await guarded.app.ctx.orchestrator.createTask(guarded.userA, { title: 'guarded merge', description: '', repos: ['acme/app'], workflowId: fast.id });
      task = await guarded.app.ctx.orchestrator.applyUserEvent(guarded.userA, task.id, 'start');
      await completeNext(guarded, guarded.userA, pr(8));
      await completeNext(guarded, guarded.userA, verdict(true));
      task = (await guarded.repo.getTask(guarded.userA, task.id))!;
      const response = await guarded.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/actions`,
        headers: { authorization: `Bearer ${guarded.tokenA}`, 'idempotency-key': 'merge-kill-switch-test' },
        payload: { event: 'accept', expectedVersion: task.version },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
      expect((await guarded.repo.getTask(guarded.userA, task.id))?.state).toBe('in-review');
    } finally {
      await guarded.app.close();
    }
  });
});
