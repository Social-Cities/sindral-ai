import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function webDistExists(dir: string): boolean {
  try {
    return existsSync(path.join(dir, 'index.html')) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Serves the built web UI. Registered on the root instance (the plugin is
 * fastify-plugin wrapped) so `reply.sendFile` is available to the not-found handler.
 */
export async function registerStatic(app: FastifyInstance, dir: string): Promise<void> {
  await app.register(fastifyStatic, { root: dir, prefix: '/', index: ['index.html'], wildcard: true, cacheControl: true, maxAge: '1h' });
}

export function jsonNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.raw.url ?? ''} not found` } });
}

/** SPA fallback: any non-API GET that is not a file gets `index.html`; everything else is a JSON 404. */
export function spaNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const url = request.raw.url ?? '';
  if (request.method === 'GET' && !url.startsWith('/api')) {
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  }
  return jsonNotFound(request, reply);
}
