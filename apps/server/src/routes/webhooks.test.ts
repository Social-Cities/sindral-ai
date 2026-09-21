import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeNext, createTestApp, plan, pr, review, testConfig, verdict, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await ctx.app.close();
});

function sign(body: string, secret = 'webhook-secret'): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function comment(overrides: Record<string, unknown> = {}, user: Record<string, unknown> = { login: 'octocat', type: 'User' }) {
  return {
    action: 'created',
    issue: { pull_request: { html_url: 'https://github.com/acme/app/pull/1' }, html_url: 'https://github.com/acme/app/pull/1' },
    comment: { id: 555, body: 'Please rename this function', user, ...overrides },
  };
}

async function post(payload: unknown, opts: { signature?: string; event?: string } = {}) {
  const body = JSON.stringify(payload);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': opts.event ?? 'issue_comment', 'x-hub-signature-256': opts.signature ?? sign(body) },
    payload: body,
  });
}

async function taskInReview() {
  const orch = ctx.app.ctx.orchestrator;
  const task = await orch.createTask(ctx.userA, { title: 't', description: '', repos: ['acme/app'] });
  await orch.applyUserEvent(ctx.userA, task.id, 'start');
  await completeNext(ctx, ctx.userA, plan());
  await orch.applyUserEvent(ctx.userA, task.id, 'approve');
  await completeNext(ctx, ctx.userA, pr(1));
  await completeNext(ctx, ctx.userA, review());
  await completeNext(ctx, ctx.userA, verdict(true));
  return task;
}

describe('GitHub webhook', () => {
  it('returns 503 when no secret is configured', async () => {
    const other = await createTestApp({ config: testConfig({ githubWebhookSecret: undefined }) });
    try {
      const res = await other.app.inject({ method: 'POST', url: '/api/webhooks/github', headers: { 'content-type': 'application/json' }, payload: '{}' });
      expect(res.statusCode).toBe(503);
    } finally {
      await other.app.close();
    }
  });

  it('rejects missing or invalid signatures', async () => {
    expect((await post(comment(), { signature: '' })).statusCode).toBe(401);
    expect((await post(comment(), { signature: sign('{}', 'wrong') })).statusCode).toBe(401);
    expect((await post(comment(), { signature: 'sha1=abc' })).statusCode).toBe(401);
  });

  it('ingests a PR comment as feedback and triggers the revision agent, idempotently', async () => {
    const task = await taskInReview();
    const res = await post(comment());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, duplicate: false, feedback: true });

    const messages = await ctx.repo.listMessages(ctx.userA, task.id);
    const ingested = messages.find((m) => m.source === 'github');
    expect(ingested).toMatchObject({ role: 'user', externalId: '555' });
    expect(ingested?.content).toBe('@octocat on GitHub:\n\nPlease rename this function');
    const fresh = await ctx.repo.getTask(ctx.userA, task.id);
    expect(fresh?.state).toBe('implement-feedback');
    const job = (await ctx.repo.listJobsForTask(ctx.userA, task.id)).find((j) => j.status === 'queued')!;
    expect((job.payload as { context: { feedback: string } }).context.feedback).toContain('Please rename this function');

    const dup = await post(comment());
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ duplicate: true });
    expect((await ctx.repo.listMessages(ctx.userA, task.id)).filter((m) => m.source === 'github')).toHaveLength(1);
  });

  it('handles review comments and ignores bots, sindral markers and non-PR comments', async () => {
    const task = await taskInReview();
    const reviewComment = { action: 'created', pull_request: { html_url: 'https://github.com/acme/app/pull/1' }, comment: { id: 777, body: 'nit', user: { login: 'bob', type: 'User' } } };
    expect((await post(reviewComment, { event: 'pull_request_review_comment' })).statusCode).toBe(200);

    expect((await post(comment({ id: 1 }, { login: 'bot[bot]', type: 'Bot' }))).statusCode).toBe(202);
    expect((await post(comment({ id: 2, body: 'Summary <!-- sindral --> hidden' }))).statusCode).toBe(202);
    expect((await post({ action: 'created', issue: { html_url: 'x' }, comment: { id: 3, body: 'issue', user: { login: 'a' } } })).statusCode).toBe(202);
    expect((await post(comment({ id: 4 }), { event: 'push' })).statusCode).toBe(202);
    expect((await post({ ...comment({ id: 5 }), action: 'edited' })).statusCode).toBe(202);
    const unknownPr = comment({ id: 6 });
    unknownPr.issue.pull_request.html_url = 'https://github.com/acme/app/pull/999';
    expect((await post(unknownPr)).statusCode).toBe(202);

    const github = (await ctx.repo.listMessages(ctx.userA, task.id)).filter((m) => m.source === 'github');
    expect(github.map((m) => m.externalId)).toEqual(['777']);
  });

  it('rejects malformed json with 400', async () => {
    const body = '{not json';
    const res = await ctx.app.inject({ method: 'POST', url: '/api/webhooks/github', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
    expect(res.statusCode).toBe(400);
  });
});
