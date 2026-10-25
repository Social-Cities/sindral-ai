import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { createVercelHandler } from './vercel.js';
import { createTestApp, testConfig, type TestContext } from './test/helpers.js';

const apps: TestContext[] = [];
const servers: Server[] = [];
const cronSecret = 'c'.repeat(32);
const vercelConfig = () => testConfig({ runtime: 'vercel', cronSecret });

async function setup(options: Parameters<typeof createTestApp>[0] = {}) {
  const ctx = await createTestApp({ config: vercelConfig(), ...options });
  apps.push(ctx);
  return ctx;
}

async function listen(handler: ReturnType<typeof createVercelHandler>) {
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const ctx of apps.splice(0)) await ctx.app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

describe('Vercel adapter', () => {
  it('shares cold-start initialization across requests and preserves routing and JSON bodies', async () => {
    const ctx = await setup();
    const initialize = vi.fn(async () => ctx.app);
    const address = await listen(createVercelHandler(initialize));
    const health = await Promise.all([fetch(`${address}/api/health`), fetch(`${address}/api/health`)]);
    expect(health.map((response) => response.status)).toEqual([200, 200]);
    expect(initialize).toHaveBeenCalledTimes(1);
    const created = await fetch(`${address}/api/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Serverless task', repos: [] }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ task: { title: 'Serverless task' } });
    expect((await fetch(`${address}/api/tasks?limit=1`, { headers: { authorization: `Bearer ${ctx.tokenA}` } })).status).toBe(200);
    expect((await fetch(`${address}/api/unknown`)).status).toBe(404);
  });

  it('returns a generic 503 and retries initialization after a failed cold start', async () => {
    const ctx = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const initialize = vi.fn(async () => ctx.app).mockRejectedValueOnce(new Error('private connection details'));
    const address = await listen(createVercelHandler(initialize));
    const first = await fetch(`${address}/api/health`);
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain('private connection details');
    expect((await fetch(`${address}/api/health`)).status).toBe(200);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('preserves exact webhook bytes for signature verification', async () => {
    const ctx = await setup();
    const address = await listen(createVercelHandler(async () => ctx.app));
    const body = '{ "action" : "unsupported", "note": "spaces matter" }\n';
    const signature = `sha256=${createHmac('sha256', ctx.config.githubWebhookSecret!).update(body).digest('hex')}`;
    const response = await fetch(`${address}/api/webhooks/github`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'ping', 'x-github-delivery': 'vercel-raw-bytes' },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('keeps the invocation alive until bounded SSE ends and refreshes across instances', async () => {
    const ctx = await setup({ sseRefreshMs: 15, sseMaxDurationMs: 250 });
    const other = await setup({ repo: ctx.repo });
    let completed = 0;
    const handler = createVercelHandler(async () => ctx.app);
    const address = await listen(async (req, res) => { await handler(req, res); completed += 1; });
    const response = await fetch(`${address}/api/events`, { headers: { authorization: `Bearer ${ctx.tokenA}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"sync"');
    expect(completed).toBe(0);
    const task = await other.app.ctx.orchestrator.createTask(ctx.userA, { title: 'Created on another function', description: '', repos: [] });
    let frames = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      frames += new TextDecoder().decode(value);
    }
    expect(frames).toContain('"sync"');
    expect(completed).toBe(1);
    expect(ctx.app.ctx.hub.subscriberCount(ctx.userA)).toBe(0);
    const refreshed = await fetch(`${address}/api/tasks`, { headers: { authorization: `Bearer ${ctx.tokenA}` } });
    expect(await refreshed.json()).toMatchObject({ tasks: [expect.objectContaining({ id: task.id })] });
    expect((await fetch(`${address}/api/events`)).status).toBe(401);
  });

  it('cleans up subscriptions when the client disconnects', async () => {
    const ctx = await setup();
    const address = await listen(createVercelHandler(async () => ctx.app));
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, { headers: { authorization: `Bearer ${ctx.tokenA}` }, signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await vi.waitFor(() => expect(ctx.app.ctx.hub.subscriberCount(ctx.userA)).toBe(0));
  });

  it('disables background sweeping even when an interval is requested', async () => {
    const ctx = await setup();
    const app = await buildApp({ config: vercelConfig(), repo: ctx.repo, sweeperIntervalMs: 1, logger: false });
    const sweep = vi.spyOn(app.ctx.orchestrator, 'sweepStaleJobs');
    await app.ready();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sweep).not.toHaveBeenCalled();
      expect(app.ctx.sseRefreshMs).toBe(5000);
      expect(app.ctx.sseMaxDurationMs).toBe(55000);
    } finally { await app.close(); }
  });

  it('supports cross-origin idempotent mutations and rejects oversized payloads', async () => {
    const ctx = await setup();
    const preflight = await ctx.app.inject({
      method: 'OPTIONS', url: '/api/tasks/example/actions',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    const large = await ctx.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { authorization: `Bearer ${ctx.tokenA}` },
      payload: { title: 'too large', description: 'x'.repeat(4 * 1024 * 1024) },
    });
    expect(large.statusCode).toBe(413);
  });
});

describe('scheduled maintenance', () => {
  it('requires the cron secret rather than a user token and awaits recovery', async () => {
    const ctx = await setup();
    const sweep = vi.spyOn(ctx.app.ctx.orchestrator, 'sweepStaleJobs').mockResolvedValue({ requeued: 2, failed: 1 });
    for (const authorization of ['', `Bearer ${ctx.tokenA}`, `Bearer ${cronSecret}wrong`]) {
      expect((await ctx.app.inject({ url: '/api/cron/sweep', headers: { authorization } })).statusCode).toBe(401);
    }
    expect(sweep).not.toHaveBeenCalled();
    const response = await ctx.app.inject({ url: '/api/cron/sweep', headers: { authorization: `Bearer ${cronSecret}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ ok: true, requeued: 2, failed: 1 });
    const local = await setup({ config: testConfig() });
    expect((await local.app.inject({ url: '/api/cron/sweep' })).statusCode).toBe(404);
  });

  it('serializes recovery across instances and releases the lease on failure', async () => {
    const ctx = await setup();
    const other = await setup({ repo: ctx.repo });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.spyOn(ctx.repo, 'listActiveJobs').mockImplementationOnce(async () => {
      entered(); await gate; throw new Error('database unavailable');
    });
    const first = ctx.app.ctx.orchestrator.sweepStaleJobs().catch((error: unknown) => error);
    await started;
    expect(await other.app.ctx.orchestrator.sweepStaleJobs()).toEqual({ requeued: 0, failed: 0 });
    expect(list).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBeInstanceOf(Error);
    expect(await other.app.ctx.orchestrator.sweepStaleJobs()).toEqual({ requeued: 0, failed: 0 });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
