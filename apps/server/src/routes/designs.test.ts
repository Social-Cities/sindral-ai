import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_PROTOCOL_HEADER, WORKER_PROTOCOL_VERSION, type DesignResult, type Task } from '@sindral/shared';
import { claimNext, createTestApp, type TestContext } from '../test/helpers.js';

function result(): DesignResult {
  const content = '<!doctype html><html><body><button onclick="this.textContent=\'Clicked\'">Hello design</button></body></html>';
  return { kind: 'design', summary: 'A dashboard design', designUrl: null, specification: 'Build the dashboard using the exported components. Support loading and empty states.',
    outcome: 'A reviewed dashboard design', acceptanceCriteria: '- Dashboard is responsive', questions: [], screens: [{ name: 'Dashboard', path: 'index.html' }],
    files: [{ path: 'index.html', contentType: 'text/html', encoding: 'utf8', content, sha256: createHash('sha256').update(content).digest('hex') }] };
}

describe('portable design workflow', () => {
  let ctx: TestContext;
  let task: Task;
  beforeEach(async () => {
    ctx = await createTestApp();
    const workflows = await ctx.app.ctx.workflows.list(ctx.userA);
    const workflow = workflows.find((item) => item.steps.some((step) => step.output === 'design'))!;
    task = await ctx.app.ctx.orchestrator.createTask(ctx.userA, { title: 'Design a dashboard', description: 'A dashboard for project managers', repos: [], workflowId: workflow.id });
    task = await ctx.app.ctx.orchestrator.applyUserEvent(ctx.userA, task.id, 'start');
  });
  afterEach(async () => { await ctx.app.close(); });

  it('keeps the current preview during clarification and uses its specification for the next turn', async () => {
    const first = (await claimNext(ctx, ctx.userA))!;
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, first.id, result(), first.attempt, first.leaseToken);
    const revision = (await ctx.repo.listDesignRevisions(ctx.userA, task.id))[0]!;
    expect(revision.result.designUrl).toBeNull();
    await ctx.app.ctx.orchestrator.postUserMessage(ctx.userA, task.id, 'Change the navigation', 'web');
    const clarification = (await claimNext(ctx, ctx.userA))!;
    expect(clarification.payload).toMatchObject({ step: { prompt: expect.stringContaining(`Continue the saved design files from revision ${revision.id}`) } });
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, clarification.id,
      { kind: 'design', summary: 'Which navigation style?', designUrl: null, specification: '', questions: ['Sidebar or top navigation?'], screens: [], files: [] },
      clarification.attempt, clarification.leaseToken);
    expect(await ctx.repo.listDesignRevisions(ctx.userA, task.id)).toHaveLength(1);
    await ctx.app.ctx.orchestrator.postUserMessage(ctx.userA, task.id, 'Use a sidebar', 'web');
    const next = (await claimNext(ctx, ctx.userA))!;
    expect(next.payload).toMatchObject({ step: { prompt: expect.stringContaining(result().specification) } });
  });

  it('restores the conversation on another worker and rejects stale or cross-tenant capabilities', async () => {
    const key = await ctx.workerKeyFor(ctx.userA);
    const headers = { authorization: `Bearer ${key}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION) };
    const first = (await claimNext(ctx, ctx.userA))!;
    const access = { attempt: first.attempt, leaseToken: first.leaseToken };
    const sessionKey = { projectKey: `sindral-task-${task.id}`, sessionId: randomUUID() };
    const entry = { type: 'assistant', uuid: randomUUID(), message: { content: 'Keep the sidebar narrow' } };
    const append = () => ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${first.id}/session/append`, headers, payload: { ...access, key: sessionKey, entries: [entry] } });
    expect((await append()).statusCode).toBe(200);
    expect((await append()).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${first.id}/session/checkpoint`, headers, payload: { ...access, sessionId: sessionKey.sessionId, files: result().files } })).statusCode).toBe(200);
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, first.id, result(), first.attempt, first.leaseToken, sessionKey.sessionId);
    expect((await append()).statusCode).toBe(409);
    await ctx.app.ctx.orchestrator.postUserMessage(ctx.userA, task.id, 'Make the sidebar smaller', 'web');
    const second = (await claimNext(ctx, ctx.userA))!;
    expect(second.workerId).not.toBe(first.workerId);
    const secondAccess = { attempt: second.attempt, leaseToken: second.leaseToken };
    const restored = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${second.id}/session`, headers, payload: secondAccess });
    expect(restored.json().checkpoint).toMatchObject({ sessionId: sessionKey.sessionId, files: result().files });
    const load = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${second.id}/session/load`, headers, payload: { ...secondAccess, key: sessionKey } });
    expect(load.json().entries).toEqual([entry]);
    const otherKey = await ctx.workerKeyFor(ctx.userB);
    const other = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${second.id}/session`, headers: { ...headers, authorization: `Bearer ${otherKey}` }, payload: secondAccess });
    expect(other.statusCode).toBe(409);
    const wrongWorkspace = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${second.id}/session/load`, headers, payload: { ...secondAccess, key: { ...sessionKey, projectKey: `sindral-task-${randomUUID()}` } } });
    expect(wrongWorkspace.statusCode).toBe(409);
  });

  it('queues feedback during generation and dispatches a subsequent turn without cancelling the first', async () => {
    const first = (await claimNext(ctx, ctx.userA))!;
    await ctx.app.ctx.orchestrator.postUserMessage(ctx.userA, task.id, 'Use a blue sidebar', 'web');
    expect((await ctx.repo.getJob(ctx.userA, first.id))?.status).toBe('claimed');
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, first.id, result(), first.attempt, first.leaseToken);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('design-revising');
    const next = (await claimNext(ctx, ctx.userA))!;
    expect(next.payload).toMatchObject({ kind: 'agent', context: { feedback: 'Use a blue sidebar' } });
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id)).filter((job) => job.status === 'cancelled')).toHaveLength(0);
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, next.id, result(), next.attempt, next.leaseToken);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('design-review');
  });

  it('requires approval, freezes handoffs, deduplicates task creation, and survives source deletion', async () => {
    const first = (await claimNext(ctx, ctx.userA))!;
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, first.id, result(), first.attempt, first.leaseToken);
    const design = (await ctx.repo.listDesignRevisions(ctx.userA, task.id))[0]!;
    const headers = { authorization: `Bearer ${ctx.tokenA}` };
    const create = { title: 'Build dashboard', description: 'Implement dashboard', repos: ['acme/app'], designHandoff: { revisionId: design.id, idempotencyKey: randomUUID() } };
    expect((await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: create })).statusCode).toBe(409);
    task = (await ctx.repo.getTask(ctx.userA, task.id))!;
    expect((await ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/design/approve`, headers, payload: { revisionId: design.id, expectedVersion: task.version - 1 } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/design/approve`, headers, payload: { revisionId: design.id, expectedVersion: task.version } })).statusCode).toBe(200);
    const created = await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: create });
    expect(created.statusCode).toBe(201);
    const implementation = created.json().task as Task;
    const replay = await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: create });
    expect(replay.json().task.id).toBe(implementation.id);
    const changed = await ctx.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { ...create, title: 'Different title' } });
    expect(changed.statusCode).toBe(409);
    await ctx.app.ctx.orchestrator.deleteTask(ctx.userA, task.id);
    const input = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${implementation.id}/design`, headers });
    expect(input.json().input.result).toEqual(result());
    const preview = await ctx.app.inject({ method: 'GET', url: input.json().inputPreviewUrls[0] });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-security-policy']).toContain('sandbox allow-scripts');
    await ctx.app.ctx.orchestrator.applyUserEvent(ctx.userA, implementation.id, 'start');
    const job = (await claimNext(ctx, ctx.userA))!;
    expect(job.payload).toMatchObject({ designHandoff: { revisionId: design.id } });
    if (job.payload.kind !== 'agent') throw new Error('Expected an agent job');
    expect(job.payload.designHandoff).not.toHaveProperty('result');
    const workerKey = await ctx.workerKeyFor(ctx.userA);
    const downloaded = await ctx.app.inject({ method: 'POST', url: `/api/worker/jobs/${job.id}/design-input`,
      headers: { authorization: `Bearer ${workerKey}`, [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION) }, payload: { attempt: job.attempt, leaseToken: job.leaseToken } });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.json().input.result).toEqual(result());
  });

  it('serves an isolated preview and never exposes another tenant’s revisions', async () => {
    const first = (await claimNext(ctx, ctx.userA))!;
    await ctx.app.ctx.orchestrator.completeJob(ctx.userA, first.id, result(), first.attempt, first.leaseToken);
    const own = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/design/revisions/${first.id}`, headers: { authorization: `Bearer ${ctx.tokenA}` } });
    expect(own.statusCode).toBe(200);
    const url = own.json().previewUrls[0] as string;
    const preview = await ctx.app.inject({ method: 'GET', url });
    expect(preview.body).toContain('Hello design');
    expect(preview.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(preview.headers['cache-control']).toBe('no-store');
    expect((await ctx.app.inject({ method: 'GET', url: `${url}tampered` })).statusCode).toBe(404);
    const other = await ctx.app.inject({ method: 'GET', url: `/api/tasks/${task.id}/design/revisions/${first.id}`, headers: { authorization: `Bearer ${ctx.tokenB}` } });
    expect(other.statusCode).toBe(404);
  });

  it('rejects file corruption before completing a job', async () => {
    const job = (await claimNext(ctx, ctx.userA))!;
    const corrupted = result(); corrupted.files[0]!.content = 'changed';
    await expect(ctx.app.ctx.orchestrator.completeJob(ctx.userA, job.id, corrupted, job.attempt, job.leaseToken)).rejects.toThrow('checksum');
    expect(await ctx.repo.listDesignRevisions(ctx.userA, task.id)).toHaveLength(0);
  });
});
