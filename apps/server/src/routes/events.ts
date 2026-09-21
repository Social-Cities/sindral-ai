import type { ServerEvent } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';

/**
 * Server-sent events. The UI authenticates with the Bearer header (fetch streaming,
 * not EventSource). Frames are `data: <ServerEvent JSON>\n\n`; a `ping` is sent
 * every `ssePingMs` to keep proxies from closing the connection.
 */
export const eventRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));
  const open = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const close of [...open]) close();
  });

  app.get('/api/events', async (request, reply) => {
    const userId = request.user!.id;
    const res: ServerResponse = reply.raw;
    reply.hijack();
    // Headers set by cors/helmet hooks live on the Fastify reply; copy them onto the raw response.
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    headers['content-type'] = 'text/event-stream; charset=utf-8';
    headers['cache-control'] = 'no-cache, no-transform';
    headers.connection = 'keep-alive';
    headers['x-accel-buffering'] = 'no';
    res.writeHead(200, headers);
    res.flushHeaders();

    const send = (event: ServerEvent): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'ping' });
    const unsubscribe = ctx.hub.subscribe(userId, send);
    const timer = setInterval(() => send({ type: 'ping' }), ctx.ssePingMs);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      open.delete(close);
      if (!res.writableEnded) res.end();
    };
    open.add(close);
    request.raw.on('close', close);
    res.on('error', close);
  });
};
