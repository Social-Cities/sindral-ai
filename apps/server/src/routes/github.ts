import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { GitHubOAuthError } from '../services/githubOAuth.js';
import { validate } from '../validate.js';

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(500).optional(),
  state: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
});

const connectBodySchema = z.object({
  returnTo: z.enum(['web', 'ios']).default('web'),
}).default({ returnTo: 'web' });

export const githubRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  const userOnly = { onRequest: requireUser(ctx.userVerifier) };

  app.get('/api/github/catalog', userOnly, async (request) => ctx.github.catalog(request.user!.id));

  app.post('/api/github/connect', userOnly, async (request) => {
    const { returnTo } = validate(connectBodySchema, request.body);
    return { url: ctx.githubOAuth.authorizationUrl(request.user!.id, returnTo) };
  });

  app.get('/api/github/callback', async (request, reply) => {
    const query = validate(callbackQuerySchema, request.query);
    const returnTo = ctx.githubOAuth.callbackReturnTo(query.state);
    if (query.error || !query.code || !query.state) {
      return reply.redirect(ctx.githubOAuth.settingsRedirect({ error: query.error ? 'denied' : 'missing' }, returnTo));
    }
    try {
      await ctx.githubOAuth.complete(query.code, query.state);
      return reply.redirect(ctx.githubOAuth.settingsRedirect({ connected: true }, returnTo));
    } catch (error) {
      request.log.warn({ err: error }, 'GitHub OAuth callback failed');
      return reply.redirect(ctx.githubOAuth.settingsRedirect({ error: error instanceof GitHubOAuthError ? error.reason : 'exchange' }, returnTo));
    }
  });
};
