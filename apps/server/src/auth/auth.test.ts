import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, mintToken, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await ctx.app.close();
});

describe('user authentication', () => {
  it('rejects missing, malformed, wrongly signed and expired tokens', async () => {
    const cases = [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer not-a-jwt' },
      { authorization: `Bearer ${await mintToken(ctx.userA, 'a@x.io', { secret: 'another-secret-another-secret-another-secret' })}` },
      { authorization: `Bearer ${await mintToken(ctx.userA, 'a@x.io', { expired: true })}` },
      { authorization: `Bearer ${await mintToken(ctx.userA, 'a@x.io', { aud: 'anon', role: 'anon' })}` },
    ];
    for (const headers of cases) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/me', headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('accepts a valid token and exposes the profile', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${ctx.tokenA}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: ctx.userA, email: 'a@example.com', displayName: 'a' } });
  });

  it('does not accept a worker key on user routes', async () => {
    const key = await ctx.workerKeyFor(ctx.userA);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(401);
  });

  it('health is public and everything else is not', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/tasks' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/worker/register' })).statusCode).toBe(401);
  });
});

describe('worker authentication', () => {
  const register = (key: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/worker/register', headers: { authorization: `Bearer ${key}` }, payload: { name: 'mac', hostname: 'mac.local', version: '0.1.0' } });

  it('rejects unknown, malformed and revoked keys', async () => {
    expect((await register('sk_sindral_' + '0'.repeat(40))).statusCode).toBe(401);
    expect((await register('sk_other_' + '0'.repeat(40))).statusCode).toBe(401);
    expect((await register(ctx.tokenA)).statusCode).toBe(401);
    const key = await ctx.workerKeyFor(ctx.userA);
    expect((await register(key)).statusCode).toBe(200);
    const [record] = await ctx.repo.listWorkerKeys(ctx.userA);
    await ctx.repo.revokeWorkerKey(ctx.userA, record!.id);
    expect((await register(key)).statusCode).toBe(401);
  });

  it('scopes the worker to the key owner', async () => {
    const key = await ctx.workerKeyFor(ctx.userA);
    const res = await register(key);
    const { workerId } = res.json<{ workerId: string }>();
    expect(await ctx.repo.getWorker(ctx.userA, workerId)).not.toBeNull();
    expect(await ctx.repo.getWorker(ctx.userB, workerId)).toBeNull();
    const [record] = await ctx.repo.listWorkerKeys(ctx.userA);
    expect(record?.lastUsedAt).not.toBeNull();
  });
});
