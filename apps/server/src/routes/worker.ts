import { setTimeout as sleep } from 'node:timers/promises';
import {
  workerClaimSchema,
  workerHeartbeatSchema,
  workerIdentitySchema,
  workerJobCancelSchema,
  workerJobCompleteSchema,
  workerJobEventSchema,
  workerJobFailSchema,
  workerRegisterSchema,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  type JobDispatch,
  type JobKind,
} from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireWorker } from '../auth/worker.js';
import type { RouteOptions } from '../context.js';
import { conflict, notFound, upgradeRequired } from '../errors.js';
import { idParamsSchema, validate } from '../validate.js';
import { hasGitHubAppCredentials, mintGitHubInstallationToken } from '../services/githubApp.js';
import { withComputedStatus } from './workers.js';

function repositoriesForJob(job: JobDispatch['job']): string[] {
  switch (job.payload.kind) {
    case 'agent':
    case 'rebase-stack':
      return job.payload.repos;
    case 'resolve-rebase-conflict':
      return [job.payload.repository];
    case 'merge-pull-requests':
      return job.payload.pullRequests.map((pullRequest) => pullRequest.repository);
  }
}

const NON_MERGE_JOB_KINDS: JobKind[] = ['agent', 'rebase-stack', 'resolve-rebase-conflict'];

export const workerRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireWorker(ctx.repo));
  app.addHook('onRequest', async (request, reply) => {
    const received = request.headers[WORKER_PROTOCOL_HEADER];
    if (received !== String(WORKER_PROTOCOL_VERSION)) {
      const clientProtocolVersion = typeof received === 'string' ? received : null;
      reply.header('upgrade', `sindral-worker/${WORKER_PROTOCOL_VERSION}`);
      throw upgradeRequired(
        `Worker protocol ${clientProtocolVersion ?? 'missing'} is incompatible; this server requires protocol ${WORKER_PROTOCOL_VERSION}. Upgrade the worker and server together.`,
        { clientProtocolVersion, serverProtocolVersion: WORKER_PROTOCOL_VERSION },
      );
    }
  });
  const { repo, orchestrator, hub } = ctx;

  app.post('/api/worker/register', async (request) => {
    const { userId, workerKeyId } = request.worker!;
    const input = validate(workerRegisterSchema, request.body);
    const now = new Date().toISOString();
    const patch = { name: input.name, hostname: input.hostname, version: input.version, status: 'online' as const, lastSeenAt: now };
    const existing = input.workerId ? await repo.updateWorker(userId, input.workerId, patch) : null;
    const worker = existing ?? (await repo.createWorker(userId, { name: input.name, hostname: input.hostname, version: input.version, workerKeyId }));
    hub.publish(userId, { type: 'worker.updated', workerId: worker.id });
    return { workerId: worker.id, protocolVersion: WORKER_PROTOCOL_VERSION };
  });

  app.post('/api/worker/heartbeat', async (request) => {
    const { userId } = request.worker!;
    const input = validate(workerHeartbeatSchema, request.body);
    const worker = await repo.updateWorker(userId, input.workerId, {
      status: 'online',
      runningJobs: input.runningJobs.length,
      lastSeenAt: new Date().toISOString(),
    });
    if (!worker) throw notFound('Worker');
    await repo.renewJobLeases(userId, worker.id, input.runningJobs);
    const cancelledJobIds = await repo.jobCancellationRequests(userId, worker.id, input.runningJobs);
    hub.publish(userId, { type: 'worker.updated', workerId: worker.id });
    return { ok: true as const, cancelledJobIds };
  });

  app.post('/api/worker/disconnect', async (request) => {
    const { userId } = request.worker!;
    const { workerId } = validate(workerIdentitySchema, request.body);
    const worker = await repo.updateWorker(userId, workerId, { status: 'offline', runningJobs: 0 });
    if (!worker) throw notFound('Worker');
    hub.publish(userId, { type: 'worker.updated', workerId: worker.id });
    return { ok: true as const };
  });

  app.post('/api/worker/cleanup-status', async (request) => {
    const { userId } = request.worker!;
    const { workerId } = validate(workerIdentitySchema, request.body);
    const worker = await repo.getWorker(userId, workerId);
    if (!worker) throw notFound('Worker');
    const now = new Date();
    const activeJobs = [];
    for (const job of await repo.listActiveJobsForWorker(userId, workerId)) {
      if (job.status !== 'applying' && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now.getTime())) continue;
      const task = await repo.getTask(userId, job.taskId);
      if (task) activeJobs.push({ jobId: job.id, taskKey: task.key });
    }
    return { workerOnline: withComputedStatus(worker, now.getTime()).status === 'online', activeJobs };
  });

  app.post('/api/worker/jobs/claim', async (request) => {
    const { userId } = request.worker!;
    const input = validate(workerClaimSchema, request.body);
    const worker = await repo.getWorker(userId, input.workerId);
    if (!worker) throw notFound('Worker');
    await repo.updateWorker(userId, worker.id, { lastSeenAt: new Date().toISOString(), status: 'online' });
    if (!ctx.config.jobDispatchEnabled) return { jobs: [] as JobDispatch[] };

    let disconnected = false;
    request.raw.once('close', () => {
      disconnected = true;
    });
    const deadline = Date.now() + ctx.claim.waitMs;
    const allowedKinds = ctx.config.autoMergeEnabled ? undefined : NON_MERGE_JOB_KINDS;
    let jobs = await repo.claimJobs(userId, worker.id, input.max, allowedKinds);
    while (jobs.length === 0 && !disconnected && Date.now() < deadline) {
      await sleep(Math.min(ctx.claim.pollMs, Math.max(0, deadline - Date.now())));
      if (disconnected) break;
      jobs = await repo.claimJobs(userId, worker.id, input.max, allowedKinds);
    }
    if (jobs.length === 0) return { jobs: [] as JobDispatch[] };

    const useGitHubApp = hasGitHubAppCredentials(ctx.config, userId);
    const github = await ctx.githubOAuth.credential(userId);
    const dispatches: JobDispatch[] = [];
    for (const claimed of jobs) {
      const { leaseToken, ...job } = claimed;
      let appToken: string | null = null;
      if (useGitHubApp) {
        try {
          appToken = await mintGitHubInstallationToken(ctx.config, userId, repositoriesForJob(job), ctx.fetch);
        } catch (error) {
          if (!github) throw error;
          ctx.log.warn({ err: error, jobId: job.id }, 'GitHub App cannot access job repositories; using connected user credential');
        }
      }
      dispatches.push({
        job,
        lease: { token: leaseToken, expiresAt: job.leaseExpiresAt! },
        credentials: {
          githubToken: appToken ?? github?.token ?? null,
          githubCredential: appToken ? 'github-app' : github?.token ? 'pat' : null,
        },
      });
      ctx.metrics.observe('sindral_job_claim_latency_seconds', Math.max(0, (Date.now() - Date.parse(job.createdAt)) / 1000), { kind: job.kind });
    }
    for (const job of jobs) hub.publish(userId, { type: 'task.updated', taskId: job.taskId });
    return { jobs: dispatches };
  });

  app.post('/api/worker/jobs/:id/events', async (request) => {
    const { userId } = request.worker!;
    const { id } = validate(idParamsSchema, request.params);
    const input = validate(workerJobEventSchema, request.body);
    const job = await repo.getJob(userId, id);
    if (!job) throw notFound('Job');
    if (!(await repo.activateJobLease(userId, id, input.attempt, input.leaseToken))) throw conflict('Job lease has expired or been superseded');
    if (job.status !== 'claimed' && job.status !== 'running') throw conflict(`Job is ${job.status}`);
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
    const { attempt, leaseToken, result } = validate(workerJobCompleteSchema, request.body);
    await orchestrator.completeJob(userId, id, result, attempt, leaseToken);
    return { ok: true as const };
  });

  app.post('/api/worker/jobs/:id/fail', async (request) => {
    const { userId } = request.worker!;
    const { id } = validate(idParamsSchema, request.params);
    const { attempt, leaseToken, error } = validate(workerJobFailSchema, request.body);
    await orchestrator.failJob(userId, id, error, attempt, leaseToken);
    return { ok: true as const };
  });

  app.post('/api/worker/jobs/:id/cancelled', async (request) => {
    const { userId } = request.worker!;
    const { id } = validate(idParamsSchema, request.params);
    const { attempt, leaseToken } = validate(workerJobCancelSchema, request.body);
    if (!(await repo.acknowledgeJobCancellation(userId, id, attempt, leaseToken))) throw conflict('Job cancellation was not requested or the lease has been superseded');
    return { ok: true as const };
  });
};
