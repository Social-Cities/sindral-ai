import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RouteOptions } from '../context.js';
import { notFound, unauthorized } from '../errors.js';

export const maintenanceRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.get('/api/cron/sweep', async (request, reply) => {
    if (!ctx.config.cronSecret) throw notFound();
    const expected = createHash('sha256').update(`Bearer ${ctx.config.cronSecret}`).digest();
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expected, supplied)) throw unauthorized();
    reply.header('cache-control', 'no-store');
    return { ok: true, ...await ctx.orchestrator.sweepStaleJobs() };
  });
};
