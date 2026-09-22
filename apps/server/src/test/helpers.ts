import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AgentResult, Job, Task } from '@sindral/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../app.js';
import type { AppConfig } from '../config.js';
import { MemoryRepository } from '../db/memory.js';
import type { ClaimedJob } from '../db/repository.js';
import { generateWorkerKey } from '../services/crypto.js';

export const TEST_JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-hs256-0123456789';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    environment: 'development',
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseAnonKey: 'anon',
    supabaseServiceRoleKey: 'service',
    supabaseJwtSecret: TEST_JWT_SECRET,
    port: 0,
    host: '127.0.0.1',
    webOrigins: ['http://localhost:5173'],
    secretsEncryptionKey: Buffer.from('ab'.repeat(32), 'hex'),
    githubWebhookSecret: 'webhook-secret',
    githubAppId: undefined,
    githubAppPrivateKey: undefined,
    githubAppInstallations: {},
    metricsToken: 'test-metrics-token-that-is-long-enough',
    jobDispatchEnabled: true,
    autoMergeEnabled: true,
    logLevel: 'silent',
    webDistDir: '/nonexistent',
    ...overrides,
  };
}

export async function mintToken(userId: string, email = `${userId.slice(0, 8)}@example.com`, opts: { expired?: boolean; secret?: string; aud?: string; role?: string } = {}): Promise<string> {
  const key = new TextEncoder().encode(opts.secret ?? TEST_JWT_SECRET);
  const jwt = new SignJWT({ email, role: opts.role ?? 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuedAt(opts.expired ? Math.floor(Date.now() / 1000) - 7200 : undefined);
  jwt.setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 3600 : '1h');
  return jwt.sign(key);
}

export interface TestContext {
  app: FastifyInstance;
  repo: MemoryRepository;
  config: AppConfig;
  userA: string;
  userB: string;
  tokenA: string;
  tokenB: string;
  workerKeyFor(userId: string): Promise<string>;
}

export async function createTestApp(options: Partial<AppOptions> = {}): Promise<TestContext> {
  const config = options.config ?? testConfig();
  const repo = (options.repo as MemoryRepository | undefined) ?? new MemoryRepository();
  const app = await buildApp({
    logger: false,
    claim: { waitMs: 0, pollMs: 0 },
    sweeperIntervalMs: 0,
    ssePingMs: 40,
    serveWeb: false,
    ...options,
    config,
    repo,
  });
  await app.ready();
  const userA = randomUUID();
  const userB = randomUUID();
  return {
    app,
    repo,
    config,
    userA,
    userB,
    tokenA: await mintToken(userA, 'a@example.com'),
    tokenB: await mintToken(userB, 'b@example.com'),
    async workerKeyFor(userId) {
      const generated = generateWorkerKey();
      await repo.createWorkerKey(userId, { name: 'test', keyHash: generated.hash, keyPrefix: generated.prefix });
      return generated.secret;
    },
  };
}

/** Test-side stand-in for a worker: claims the next job for the user and returns it. */
export async function claimNext(ctx: TestContext, userId: string, workerId?: string): Promise<ClaimedJob | null> {
  const id = workerId ?? (await ctx.repo.createWorker(userId, { name: 'w', hostname: 'h', version: '1', workerKeyId: null })).id;
  const jobs = await ctx.repo.claimJobs(userId, id, 1);
  return jobs[0] ?? null;
}

export async function completeNext(ctx: TestContext, userId: string, result: AgentResult): Promise<Job> {
  const job = await claimNext(ctx, userId);
  if (!job) throw new Error('no job to claim');
  await ctx.app.ctx.orchestrator.completeJob(userId, job.id, result, job.attempt, job.leaseToken);
  return job;
}

export async function completeMerge(ctx: TestContext, userId: string): Promise<Job> {
  const job = await claimNext(ctx, userId);
  if (!job) throw new Error('no merge job to claim');
  if (job.payload.kind !== 'merge-pull-requests') throw new Error(`expected merge job, received ${job.payload.kind}`);
  await ctx.app.ctx.orchestrator.completeJob(userId, job.id, {
    kind: 'merge',
    summary: `Merged ${job.payload.pullRequests.length} pull request(s).`,
    complete: true,
    pullRequests: job.payload.pullRequests.map((pullRequest) => ({
      id: pullRequest.id,
      repository: pullRequest.repository,
      url: pullRequest.url,
      merged: true,
      mergedAt: '2026-09-21T12:00:00.000Z',
    })),
  }, job.attempt, job.leaseToken);
  return job;
}

export async function reload(ctx: TestContext, userId: string, task: Task): Promise<Task> {
  const fresh = await ctx.repo.getTask(userId, task.id);
  if (!fresh) throw new Error('task vanished');
  return fresh;
}

export const plan = (text = '# Plan', subtasks?: { title: string; goal: string }[]): AgentResult =>
  subtasks ? { kind: 'plan', summary: 'planned', plan: text, subtasks } : { kind: 'plan', summary: 'planned', plan: text };
export const pr = (n = 1, branch = 'sindral/sin-1'): AgentResult => ({
  kind: 'pr',
  summary: `opened PR ${n}`,
  prUrl: `https://github.com/acme/app/pull/${n}`,
  branch,
  pullRequests: [
    {
      repository: 'acme/app',
      prUrl: `https://github.com/acme/app/pull/${n}`,
      number: n,
      branch,
      baseBranch: 'main',
      headSha: 'a'.repeat(40),
    },
  ],
});
export const review = (): AgentResult => ({ kind: 'review', summary: 'reviewed', report: '# Review', verdict: 'NO_MATERIAL_FINDINGS' });
export const verdict = (go: boolean, feedback?: string): AgentResult =>
  go ? { kind: 'verdict', summary: 'GO', report: '# Verify', verdict: 'GO' } : { kind: 'verdict', summary: 'NO_GO', report: '# Verify', verdict: 'NO_GO', feedback };
