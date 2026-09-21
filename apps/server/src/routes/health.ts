import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
};
