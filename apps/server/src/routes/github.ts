import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { validate } from '../validate.js';

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(500).optional(),
  state: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
});

export const githubRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  const userOnly = { onRequest: requireUser(ctx.userVerifier) };

  app.get('/api/github/catalog', userOnly, async (request) => ctx.github.catalog(request.user!.id));

  app.post('/api/github/connect', userOnly, async (request) => ({ url: ctx.githubOAuth.authorizationUrl(request.user!.id) }));

  app.get('/api/github/callback', async (request, reply) => {
    const query = validate(callbackQuerySchema, request.query);
    if (query.error || !query.code || !query.state) return reply.redirect(ctx.githubOAuth.settingsRedirect({ error: query.error ?? 'missing_code' }));
    try {
      await ctx.githubOAuth.complete(query.code, query.state);
      return reply.redirect(ctx.githubOAuth.settingsRedirect({ connected: true }));
    } catch (error) {
      request.log.warn({ err: error }, 'GitHub OAuth callback failed');
      return reply.redirect(ctx.githubOAuth.settingsRedirect({ error: 'authorization_failed' }));
    }
  });
};
