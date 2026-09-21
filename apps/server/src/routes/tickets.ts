import { importTicketSchema } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { validate } from '../validate.js';

export const ticketRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));

  app.post('/api/tickets/import', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { url } = validate(importTicketSchema, request.body);
    const ticket = await ctx.tickets.import(request.user!.id, url);
    return { ticket };
  });
};
