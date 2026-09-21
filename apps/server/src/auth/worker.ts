import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repository } from '../db/repository.js';
import { unauthorized } from '../errors.js';
import { WORKER_KEY_RE, hashWorkerKey, safeEqual } from '../services/crypto.js';
import { extractBearer } from './user.js';

export interface WorkerAuth {
  userId: string;
  workerKeyId: string;
}

const TOUCH_INTERVAL_MS = 60_000;

/** Fastify `onRequest` hook authenticating `sk_sindral_...` keys and attaching `request.worker`. */
export function requireWorker(repo: Repository, now: () => Date = () => new Date()) {
  const lastTouched = new Map<string, number>();

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = extractBearer(request);
    if (!token || !WORKER_KEY_RE.test(token)) throw unauthorized('Invalid worker key');
    const hash = hashWorkerKey(token);
    const key = await repo.findWorkerKeyByHash(hash);
    if (!key || !safeEqual(key.keyHash, hash)) throw unauthorized('Invalid worker key');
    if (key.revokedAt) throw unauthorized('Worker key has been revoked');

    const ts = now().getTime();
    const last = lastTouched.get(key.id) ?? 0;
    if (ts - last > TOUCH_INTERVAL_MS) {
      lastTouched.set(key.id, ts);
      // Best effort; a failed timestamp update must not block the worker.
      repo.touchWorkerKey(key.userId, key.id, new Date(ts).toISOString()).catch(() => undefined);
    }
    request.worker = { userId: key.userId, workerKeyId: key.id };
  };
}
