import type { AuthUser } from './auth/user.js';
import type { WorkerAuth } from './auth/worker.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    worker: WorkerAuth | null;
    /** Raw JSON body, kept only for webhook signature verification. */
    rawBody: string | null;
  }
}

export {};
