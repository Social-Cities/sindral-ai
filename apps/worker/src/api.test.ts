import { describe, expect, it, vi } from 'vitest';
import { WORKER_PROTOCOL_HEADER, WORKER_PROTOCOL_VERSION } from '@sindral/shared';
import { ApiClient, ApiRequestError, MAX_DELAY_MS, WorkerAuthError, WorkerProtocolError, backoffDelay } from './api.js';
import { WORKER_KEY } from './test/fixtures.js';

const LEASE_TOKEN = '10000000-0000-4000-8000-000000000001';

function response(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  const sleeps: number[] = [];
  const api = new ApiClient({
    baseUrl: 'http://server.test/',
    workerKey: WORKER_KEY,
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    maxAttempts: 4,
    ...extra,
  });
  return { api, sleeps };
}

describe('backoffDelay', () => {
  it('grows exponentially with jitter and caps near 30s', () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(20, () => 1)).toBe(MAX_DELAY_MS);
    expect(backoffDelay(20, () => 0)).toBe(MAX_DELAY_MS / 2);
  });
});

describe('ApiClient', () => {
  it('sends bearer auth and JSON, returning the parsed body', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://server.test/api/worker/register');
      expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${WORKER_KEY}`);
      expect((init.headers as Record<string, string>)[WORKER_PROTOCOL_HEADER]).toBe(String(WORKER_PROTOCOL_VERSION));
      expect(JSON.parse(String(init.body))).toEqual({ name: 'w', hostname: 'h', version: 'v' });
      return response(200, { workerId: 'abc', protocolVersion: WORKER_PROTOCOL_VERSION });
    });
    const { api } = client(fetchImpl);
    await expect(api.register({ name: 'w', hostname: 'h', version: 'v' })).resolves.toEqual({ workerId: 'abc', protocolVersion: WORKER_PROTOCOL_VERSION });
  });

  it('retries 5xx and 429 with backoff', async () => {
    const statuses = [500, 429, 200];
    const fetchImpl = vi.fn(async () => response(statuses.shift() ?? 200, { ok: true }));
    const { api, sleeps } = client(fetchImpl);
    await expect(api.heartbeat({ workerId: 'w', runningJobs: [] })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([backoffDelay(0, () => 0.5), backoffDelay(1, () => 0.5)]);
  });

  it('retries network failures and gives up after maxAttempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { api, sleeps } = client(fetchImpl);
    await expect(api.heartbeat({ workerId: 'w', runningJobs: [] })).rejects.toThrow(/fetch failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it('does not retry other 4xx errors', async () => {
    const fetchImpl = vi.fn(async () => response(400, { error: { code: 'bad_request', message: 'nope' } }));
    const { api } = client(fetchImpl);
    const err = await api.fail('job-1', 'x', 1, LEASE_TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(400);
    expect((err as ApiRequestError).code).toBe('bad_request');
    expect((err as Error).message).toContain('nope');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws WorkerAuthError on 401 without retrying', async () => {
    const fetchImpl = vi.fn(async () => response(401, { error: { code: 'unauthorized', message: 'bad key' } }));
    const { api } = client(fetchImpl);
    await expect(api.claim({ workerId: 'w', max: 1 })).rejects.toBeInstanceOf(WorkerAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws WorkerProtocolError on 426 without retrying', async () => {
    const fetchImpl = vi.fn(async () => response(426, { error: { code: 'WORKER_PROTOCOL_MISMATCH', message: 'upgrade required' } }));
    const { api } = client(fetchImpl);
    await expect(api.register({ name: 'w', hostname: 'h', version: 'v' })).rejects.toBeInstanceOf(WorkerProtocolError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when claim has no jobs', async () => {
    const { api } = client(async () => response(200, { jobs: [] }));
    await expect(api.claim({ workerId: 'w', max: 2 })).resolves.toEqual([]);
  });

  it('reads cleanup status and disconnects through worker-authenticated routes', async () => {
    const routes: string[] = [];
    const { api } = client(async (url) => {
      routes.push(url);
      return response(200, url.endsWith('cleanup-status') ? { workerOnline: false, activeJobs: [] } : { ok: true });
    });
    await expect(api.cleanupStatus({ workerId: 'w' })).resolves.toEqual({ workerOnline: false, activeJobs: [] });
    await expect(api.disconnect({ workerId: 'w' })).resolves.toEqual({ ok: true });
    expect(routes).toEqual(['http://server.test/api/worker/cleanup-status', 'http://server.test/api/worker/disconnect']);
  });

  it('stops retrying when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort('stop');
      throw new Error('aborted');
    });
    const { api } = client(fetchImpl);
    await expect(api.claim({ workerId: 'w', max: 1 }, controller.signal)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
