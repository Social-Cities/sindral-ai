import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RouteOptions } from '../context.js';
import { notFound, unauthorized } from '../errors.js';

export const metricsRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.get('/api/metrics', async (request, reply) => {
    const expected = ctx.config.metricsToken;
    if (!expected) throw notFound('Metrics');
    const header = request.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const expectedHash = createHash('sha256').update(expected).digest();
    const providedHash = createHash('sha256').update(provided).digest();
    if (!timingSafeEqual(expectedHash, providedHash)) throw unauthorized();
    const snapshot = await ctx.repo.getOperationalSnapshot();
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(ctx.metrics.render(snapshot));
  });
};
