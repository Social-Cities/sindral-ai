import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeNext, createTestApp, plan, pr, review, testConfig, verdict, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
let deliverySequence = 0;
beforeEach(async () => {
  ctx = await createTestApp();
  deliverySequence = 0;
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
    comment: { id: 555, body: 'Please rename this function', html_url: 'https://github.com/acme/app/pull/1#issuecomment-555', user, ...overrides },
  };
}

async function post(payload: unknown, opts: { signature?: string; event?: string; delivery?: string; omitDelivery?: boolean } = {}) {
  const body = JSON.stringify(payload);
  deliverySequence += 1;
  return ctx.app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': opts.event ?? 'issue_comment',
      'x-hub-signature-256': opts.signature ?? sign(body),
      ...(!opts.omitDelivery ? { 'x-github-delivery': opts.delivery ?? `delivery-${deliverySequence}` } : {}),
    },
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

  it('requires and durably replays GitHub delivery identifiers', async () => {
    await taskInReview();
    expect((await post(comment(), { omitDelivery: true })).statusCode).toBe(400);
    const first = await post(comment(), { delivery: 'same-delivery' });
    const replay = await post(comment(), { delivery: 'same-delivery' });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());
    expect((await post(comment({ body: 'changed' }), { delivery: 'same-delivery' })).statusCode).toBe(409);
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
    expect((job.payload as { context: { github_feedback: unknown } }).context.github_feedback).toEqual({
      kind: 'issue_comment',
      commentId: '555',
      commentUrl: 'https://github.com/acme/app/pull/1#issuecomment-555',
      prUrl: 'https://github.com/acme/app/pull/1',
    });

    const dup = await post(comment());
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ duplicate: true });
    expect((await ctx.repo.listMessages(ctx.userA, task.id)).filter((m) => m.source === 'github')).toHaveLength(1);
  });

  it('recovers when the comment is saved before feedback dispatch succeeds', async () => {
    const task = await taskInReview();
    vi.spyOn(ctx.repo, 'applyTaskTransition').mockRejectedValueOnce(new Error('transient transition failure'));
    const first = await post(comment(), { delivery: 'retry-delivery' });
    expect(first.statusCode).toBe(500);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('in-review');

    const retry = await post(comment(), { delivery: 'retry-delivery' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ok: true, duplicate: true, feedback: true });
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('implement-feedback');
    expect((await ctx.repo.listMessages(ctx.userA, task.id)).filter((message) => message.source === 'github')).toHaveLength(1);
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id)).filter((job) => job.status === 'queued')).toHaveLength(1);
  });

  it('handles review comments and ignores bots, sindral markers and non-PR comments', async () => {
    const task = await taskInReview();
    const reviewComment = { action: 'created', pull_request: { html_url: 'https://github.com/acme/app/pull/1' }, comment: { id: 777, body: 'nit', html_url: 'https://github.com/acme/app/pull/1#discussion_r777', user: { login: 'bob', type: 'User' } } };
    expect((await post(reviewComment, { event: 'pull_request_review_comment' })).statusCode).toBe(200);

    expect((await post(comment({ id: 1 }, { login: 'bot[bot]', type: 'Bot' }))).statusCode).toBe(202);
    expect((await post(comment({ id: 2, body: 'Summary <!-- sindral --> hidden' }))).statusCode).toBe(202);
    expect((await post(comment({ id: '../replies', body: 'invalid id' }))).statusCode).toBe(202);
    expect((await post({ action: 'created', issue: { html_url: 'x' }, comment: { id: 3, body: 'issue', user: { login: 'a' } } })).statusCode).toBe(202);
    expect((await post(comment({ id: 4 }), { event: 'push' })).statusCode).toBe(202);
    expect((await post({ ...comment({ id: 5 }), action: 'edited' })).statusCode).toBe(202);
    const unknownPr = comment({ id: 6 });
    unknownPr.issue.pull_request.html_url = 'https://github.com/acme/app/pull/999';
    expect((await post(unknownPr)).statusCode).toBe(202);

    const github = (await ctx.repo.listMessages(ctx.userA, task.id)).filter((m) => m.source === 'github');
    expect(github.map((m) => m.externalId)).toEqual(['777']);
  });

  it('reconciles a manually merged pull request and completes a task waiting on merge', async () => {
    const task = await taskInReview();
    await ctx.app.ctx.orchestrator.applyUserEvent(ctx.userA, task.id, 'accept');
    const payload = {
      action: 'closed',
      pull_request: {
        html_url: 'https://github.com/acme/app/pull/1',
        state: 'closed',
        merged: true,
        merged_at: '2026-09-21T12:00:00Z',
      },
    };
    const response = await post(payload, { event: 'pull_request' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, reconciled: true });
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('done');
    expect((await ctx.repo.listPullRequests(ctx.userA, task.id))[0]).toMatchObject({ status: 'merged', mergedAt: '2026-09-21T12:00:00Z' });
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id)).at(-1)?.status).toBe('cancelled');

    const eventCount = (await ctx.repo.listEvents(ctx.userA, task.id)).length;
    await post(payload, { event: 'pull_request' });
    expect((await ctx.repo.listEvents(ctx.userA, task.id)).length).toBe(eventCount);
  });

  it('completes an in-review task from externally confirmed merges without dispatching merge work', async () => {
    const task = await taskInReview();
    const jobsBefore = await ctx.repo.listJobsForTask(ctx.userA, task.id);
    const response = await post({
      action: 'closed',
      pull_request: {
        html_url: 'https://github.com/acme/app/pull/1',
        state: 'closed',
        merged: true,
        merged_at: '2026-09-21T12:00:00Z',
      },
    }, { event: 'pull_request' });

    expect(response.statusCode).toBe(200);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('done');
    const jobsAfter = await ctx.repo.listJobsForTask(ctx.userA, task.id);
    expect(jobsAfter).toHaveLength(jobsBefore.length);
    expect(jobsAfter.some((job) => job.kind === 'merge-pull-requests')).toBe(false);
  });

  it('recovers task completion when PR state was stored before webhook orchestration retried', async () => {
    const task = await taskInReview();
    const pullRequest = (await ctx.repo.listPullRequests(ctx.userA, task.id))[0]!;
    await ctx.repo.upsertPullRequest(ctx.userA, task.id, {
      taskRepositoryId: pullRequest.taskRepositoryId,
      repository: pullRequest.repository,
      url: pullRequest.url,
      number: pullRequest.number,
      branch: pullRequest.branch,
      baseBranch: pullRequest.baseBranch,
      headSha: pullRequest.headSha,
      status: 'merged',
      mergedAt: '2026-09-21T12:00:00Z',
    });

    const reconciled = await ctx.app.ctx.orchestrator.reconcilePullRequest(pullRequest.url, 'merged', '2026-09-21T12:00:00Z');
    expect(reconciled).toBe(true);
    expect((await ctx.repo.getTask(ctx.userA, task.id))?.state).toBe('done');
  });

  it('rejects malformed json with 400', async () => {
    const body = '{not json';
    const res = await ctx.app.inject({ method: 'POST', url: '/api/webhooks/github', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
    expect(res.statusCode).toBe(400);
  });
});
