import { WORKER_PROTOCOL_HEADER, WORKER_PROTOCOL_VERSION, type AgentResult, type JobDispatch } from '@sindral/shared';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The worker key was rejected. The runner exits on this; retrying cannot help. */
export class WorkerAuthError extends ApiRequestError {
  override name = 'WorkerAuthError';
  constructor(message: string) {
    super(message, 401, 'unauthorized');
  }
}

/** The server and worker speak incompatible wire protocols; retries cannot help. */
export class WorkerProtocolError extends ApiRequestError {
  override name = 'WorkerProtocolError';
  constructor(message: string) {
    super(message, 426, 'WORKER_PROTOCOL_MISMATCH');
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  workerKey: string;
  fetch?: typeof fetch;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
}

export type JobEvent = { type: 'log' | 'progress' | 'message'; message: string; attempt: number; leaseToken: string };

const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 30_000;
const CLAIM_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Exponential backoff with full jitter, capped at ~30s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(exp * (0.5 + random() * 0.5));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly workerKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.workerKey = opts.workerKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.log = opts.logger ?? silentLogger();
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 6;
  }

  register(body: { name: string; hostname: string; version: string; workerId?: string }): Promise<{ workerId: string; protocolVersion: number }> {
    return this.post<{ workerId: string; protocolVersion: number }>('/api/worker/register', body);
  }

  heartbeat(body: { workerId: string; runningJobs: { jobId: string; leaseToken: string }[] }): Promise<{ ok: true }> {
    return this.post<{ ok: true }>('/api/worker/heartbeat', body);
  }

  async claim(body: { workerId: string; max: number }, signal?: AbortSignal): Promise<JobDispatch[]> {
    const res = await this.post<{ jobs: JobDispatch[] }>('/api/worker/jobs/claim', body, { timeoutMs: CLAIM_TIMEOUT_MS, signal });
    return Array.isArray(res.jobs) ? res.jobs : [];
  }

  postEvent(jobId: string, event: JobEvent): Promise<{ ok: true }> {
    return this.post<{ ok: true }>(`/api/worker/jobs/${encodeURIComponent(jobId)}/events`, event);
  }

  complete(jobId: string, result: AgentResult, attempt: number, leaseToken: string): Promise<{ ok: true }> {
    return this.post<{ ok: true }>(`/api/worker/jobs/${encodeURIComponent(jobId)}/complete`, { attempt, leaseToken, result });
  }

  fail(jobId: string, error: string, attempt: number, leaseToken: string): Promise<{ ok: true }> {
    return this.post<{ ok: true }>(`/api/worker/jobs/${encodeURIComponent(jobId)}/fail`, { attempt, leaseToken, error });
  }

  private async post<T>(route: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${route}`;
    const payload = JSON.stringify(body);
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (opts.signal?.aborted) throw new Error('request aborted');
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1, this.random);
        this.log.warn({ route, attempt, delay }, 'retrying request');
        await this.sleep(delay);
      }
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${this.workerKey}`,
            [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION),
          },
          body: payload,
          signal: combineSignals(opts.signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        lastError = err;
        this.log.debug({ route, err: errorText(err) }, 'network error');
        continue;
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }

      const { code, message } = await readError(response);
      if (response.status === 401) {
        throw new WorkerAuthError(`Server rejected the worker key (401 ${code}): ${message}. Check SINDRAL_WORKER_KEY.`);
      }
      if (response.status === 426) {
        throw new WorkerProtocolError(`Server rejected worker protocol ${WORKER_PROTOCOL_VERSION} (426 ${code}): ${message}`);
      }
      const error = new ApiRequestError(`${route} failed with ${response.status} ${code}: ${message}`, response.status, code);
      if (response.status === 429 || response.status >= 500) {
        lastError = error;
        continue;
      }
      throw error;
    }
    throw lastError instanceof Error ? lastError : new Error(`${route} failed after ${this.maxAttempts} attempts: ${errorText(lastError)}`);
  }
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  const fallback = { code: `http_${response.status}`, message: response.statusText || 'request failed' };
  try {
    const text = await response.text();
    if (!text) return fallback;
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : fallback.code;
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : fallback.message;
    return { code, message };
  } catch {
    return fallback;
  }
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  return AbortSignal.any([a, b]);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
