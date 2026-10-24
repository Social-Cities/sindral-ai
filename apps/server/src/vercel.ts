import type { IncomingMessage, ServerResponse } from 'node:http';
import { initializeApp } from './bootstrap.js';
import { loadConfig } from './config.js';

/** One initialization per warm function; rejected cold starts can be retried. */
export function createVercelHandler(initialize = () => initializeApp(loadConfig({ ...process.env, SINDRAL_RUNTIME: 'vercel' }))) {
  let pending: ReturnType<typeof initialize> | undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let app;
    try {
      pending ??= initialize();
      app = await pending;
    } catch (error) {
      pending = undefined;
      console.error('API initialization failed', error);
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'API initialization failed' } }));
      return;
    }
    if (response.destroyed || response.writableEnded) return;
    // Fastify owns parsing (including raw webhook bytes). Await the response,
    // rather than just emitting a request: SSE work must stay inside invocation lifetime.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        response.off('finish', complete);
        response.off('close', complete);
        response.off('error', fail);
      };
      const complete = () => { cleanup(); resolve(); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      response.once('finish', complete);
      response.once('close', complete);
      response.once('error', fail);
      app.server.emit('request', request, response);
    });
  };
}

export default createVercelHandler();
