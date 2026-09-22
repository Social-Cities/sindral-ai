import type { Worker } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';

export const ONLINE_WINDOW_MS = 90_000;

export function withComputedStatus(worker: Worker, now: number): Worker {
  const online = worker.status === 'online' && now - Date.parse(worker.lastSeenAt) <= ONLINE_WINDOW_MS;
  return { ...worker, status: online ? 'online' : 'offline' };
}

export const workerListRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));

  app.get('/api/workers', async (request) => {
    const now = Date.now();
    const workers = (await ctx.repo.listWorkers(request.user!.id)).map((w) => withComputedStatus(w, now));
    return { workers };
  });
};
