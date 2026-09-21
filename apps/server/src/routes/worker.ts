import { setTimeout as sleep } from 'node:timers/promises';
import {
  workerClaimSchema,
  workerHeartbeatSchema,
  workerJobCompleteSchema,
  workerJobEventSchema,
  workerJobFailSchema,
  workerRegisterSchema,
  type JobDispatch,
} from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireWorker } from '../auth/worker.js';
import type { RouteOptions } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { idParamsSchema, validate } from '../validate.js';

export const workerRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireWorker(ctx.repo));
  const { repo, orchestrator, hub } = ctx;

  app.post('/api/worker/register', async (request) => {
    const { userId, workerKeyId } = request.worker!;
    const input = validate(workerRegisterSchema, request.body);
    const now = new Date().toISOString();
    const patch = { name: input.name, hostname: input.hostname, version: input.version, status: 'online' as const, lastSeenAt: now };
    const existing = input.workerId ? await repo.updateWorker(userId, input.workerId, patch) : null;
    const worker = existing ?? (await repo.createWorker(userId, { name: input.name, hostname: input.hostname, version: input.version, workerKeyId }));
    hub.publish(userId, { type: 'worker.updated', workerId: worker.id });
    return { workerId: worker.id };
  });

  app.post('/api/worker/heartbeat', async (request) => {
    const { userId } = request.worker!;
    const input = validate(workerHeartbeatSchema, request.body);
    const worker = await repo.updateWorker(userId, input.workerId, {
      status: 'online',
      runningJobs: input.runningJobIds.length,
      lastSeenAt: new Date().toISOString(),
    });
    if (!worker) throw notFound('Worker');
    hub.publish(userId, { type: 'worker.updated', workerId: worker.id });
    return { ok: true as const };
  });

  app.post('/api/worker/jobs/claim', async (request) => {
    const { userId } = request.worker!;
    const input = validate(workerClaimSchema, request.body);
    const worker = await repo.getWorker(userId, input.workerId);
    if (!worker) throw notFound('Worker');
    await repo.updateWorker(userId, worker.id, { lastSeenAt: new Date().toISOString(), status: 'online' });

    let disconnected = false;
    request.raw.once('close', () => {
      disconnected = true;
    });
    const deadline = Date.now() + ctx.claim.waitMs;
    let jobs = await repo.claimJobs(userId, worker.id, input.max);
    while (jobs.length === 0 && !disconnected && Date.now() < deadline) {
      await sleep(Math.min(ctx.claim.pollMs, Math.max(0, deadline - Date.now())));
      if (disconnected) break;
      jobs = await repo.claimJobs(userId, worker.id, input.max);
    }
    if (jobs.length === 0) return { jobs: [] as JobDispatch[] };

    const github = await ctx.secrets.get(userId, 'github');
    const credentials = { githubToken: github?.token ?? null };
    const dispatches: JobDispatch[] = jobs.map((job) => ({ job, credentials }));
    for (const job of jobs) hub.publish(userId, { type: 'task.updated', taskId: job.taskId });
    return { jobs: dispatches };
  });

  app.post('/api/worker/jobs/:id/events', async (request) => {
    const { userId } = request.worker!;
    const { id } = validate(idParamsSchema, request.params);
    const input = validate(workerJobEventSchema, request.body);
    const job = await repo.getJob(userId, id);
    if (!job) throw notFound('Job');
    if (job.status !== 'claimed' && job.status !== 'running') throw conflict(`Job is ${job.status}`);
    if (job.status === 'claimed') await repo.updateJob(userId, id, { status: 'running' });
    await repo.appendJobLog(userId, { jobId: id, type: input.type, message: input.message });
    if (input.type === 'message') {
      await repo.createMessage(userId, { taskId: job.taskId, role: 'agent', content: input.message, source: 'worker' });
    }
    hub.publish(userId, { type: 'task.updated', taskId: job.taskId });
    return { ok: true as const };
  });

  app.post('/api/worker/jobs/:id/complete', async (request) => {
    const { userId } = request.worker!;
    const { id } = validate(idParamsSchema, request.params);
    const { result } = validate(workerJobCompleteSchema, request.body);
    await orchestrator.completeJob(userId, id, result);
    return { ok: true as const };
  });

  app.post('/api/worker/jobs/:id/fail', async (request) => {
    const { userId } = request.worker!;
    const { id } = validate(idParamsSchema, request.params);
    const { error } = validate(workerJobFailSchema, request.body);
    await orchestrator.failJob(userId, id, error);
    return { ok: true as const };
  });
};
