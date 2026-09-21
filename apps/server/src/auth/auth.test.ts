import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CryptoKey } from 'jose';
import { createTestApp, mintToken, TEST_JWT_SECRET, type TestContext } from '../test/helpers.js';
import { createUserTokenVerifier } from './user.js';

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

describe('token algorithm selection', () => {
  // Supabase projects issue either legacy HS256 tokens or asymmetric ES256/RS256 tokens
  // verified through the project's JWKS endpoint. Both must work.
  it('verifies ES256 tokens through the JWKS endpoint and still rejects bad ones', async () => {
    const { SignJWT, exportJWK, generateKeyPair } = await import('jose');
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'ES256';

    const other = await generateKeyPair('ES256', { extractable: true });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      // No HS256 secret configured: the asymmetric path must be selected from the token header.
      const verifier = createUserTokenVerifier({ supabaseUrl: 'http://127.0.0.1:54321' });
      const sign = (key: CryptoKey) =>
        new SignJWT({ email: 'es@example.com', role: 'authenticated' })
          .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
          .setSubject('11111111-1111-4111-8111-111111111111')
          .setAudience('authenticated')
          .setExpirationTime('1h')
          .sign(key);

      await expect(verifier.verify(await sign(privateKey))).resolves.toEqual({ id: '11111111-1111-4111-8111-111111111111', email: 'es@example.com' });
      await expect(verifier.verify(await sign(other.privateKey))).rejects.toThrow(/Invalid or expired token/);
      // An HS256 token cannot be smuggled in when no shared secret is configured.
      await expect(verifier.verify(await mintToken('22222222-2222-4222-8222-222222222222'))).rejects.toThrow(/Invalid or expired token/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('rejects unsigned (alg=none) tokens', async () => {
    const verifier = createUserTokenVerifier({ supabaseUrl: 'http://127.0.0.1:54321', jwtSecret: TEST_JWT_SECRET });
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'x', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    await expect(verifier.verify(`${header}.${body}.`)).rejects.toThrow(/Invalid or expired token/);
  });
});
