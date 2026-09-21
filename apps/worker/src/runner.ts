import type { JobDispatch } from '@sindral/shared';
import { WorkerAuthError, type ApiClient } from './api.js';
import type { WorkerConfig } from './config.js';
import { SHUTDOWN_REASON } from './job.js';
import type { Logger } from './logger.js';
import { errorMessage } from './redact.js';

export interface RunningJob {
  jobId: string;
  taskId: string;
  taskKeys: string[];
  startedAt: number;
}

export interface RunnerPersistence {
  loadWorkerId(): Promise<string | null>;
  saveWorkerId(id: string): Promise<void>;
  saveRunning(jobs: RunningJob[]): Promise<void>;
}

export interface RunnerDeps {
  config: Pick<WorkerConfig, 'concurrency' | 'workerName'>;
  api: Pick<ApiClient, 'register' | 'heartbeat' | 'claim' | 'fail'>;
  logger: Logger;
  runJob: (dispatch: JobDispatch, signal: AbortSignal) => Promise<unknown>;
  version: string;
  hostname: string;
  persistence?: RunnerPersistence;
  sleep?: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  /** How long to wait for running jobs on shutdown before killing them. */
  shutdownGraceMs?: number;
  /** Pause after a failed claim before polling again. */
  claimErrorBackoffMs?: number;
}

const noopPersistence: RunnerPersistence = {
  loadWorkerId: async () => null,
  saveWorkerId: async () => {},
  saveRunning: async () => {},
};

/** Task keys a dispatch touches; used for the local per-task guard and `clean`. */
export function taskKeysOf(dispatch: JobDispatch): string[] {
  const { job } = dispatch;
  if (job.payload.kind === 'agent') return [job.payload.context.task_key || job.taskId];
  return job.payload.stack.map((s) => `rebase__${s.taskId}`);
}

/**
 * Main loop: register, heartbeat, claim jobs while there are free slots and
 * run them. Never runs two jobs of the same task at once, even if the server
 * hands them over together.
 */
export class Runner {
  private readonly active = new Map<string, { job: RunningJob; controller: AbortController; done: Promise<void> }>();
  private pending: JobDispatch[] = [];
  private stopping = false;
  private stopped: Promise<void> | null = null;
  private claimAbort = new AbortController();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private wakeSlot: (() => void) | null = null;
  private workerId: string | null = null;
  private readonly persistence: RunnerPersistence;
  private readonly sleep: (ms: number) => Promise<void>;
  private fatal: Error | null = null;

  constructor(private readonly deps: RunnerDeps) {
    this.persistence = deps.persistence ?? noopPersistence;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get running(): RunningJob[] {
    return [...this.active.values()].map((a) => a.job);
  }

  get queued(): number {
    return this.pending.length;
  }

  /** Resolves once the runner has fully stopped. Rejects on fatal errors (bad key). */
  async start(): Promise<void> {
    const { deps } = this;
    const previous = await this.persistence.loadWorkerId();
    const registered = await deps.api.register({
      name: deps.config.workerName,
      hostname: deps.hostname,
      version: deps.version,
      ...(previous ? { workerId: previous } : {}),
    });
    this.workerId = registered.workerId;
    await this.persistence.saveWorkerId(registered.workerId);
    deps.logger.info({ workerId: registered.workerId, version: deps.version, concurrency: deps.config.concurrency }, 'worker registered');

    this.startHeartbeat();
    try {
      await this.claimLoop();
    } finally {
      await this.drain();
    }
    if (this.fatal) throw this.fatal;
  }

  /** Stops claiming, waits for running jobs (up to the grace period), then kills them. */
  stop(reason: string = SHUTDOWN_REASON): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.claimAbort.abort(reason);
    this.wakeSlot?.();
    this.stopped = new Promise<void>((resolve) => {
      this.onDrained = resolve;
    });
    return this.stopped;
  }

  private onDrained: (() => void) | null = null;

  private async claimLoop(): Promise<void> {
    const { deps } = this;
    const workerId = this.workerId;
    if (!workerId) throw new Error('runner not registered');
    while (!this.stopping) {
      const free = deps.config.concurrency - this.active.size;
      if (free <= 0 || this.pending.length > 0) {
        this.schedule();
        if (deps.config.concurrency - this.active.size <= 0 || this.pending.length > 0) {
          await this.waitForSlot();
          continue;
        }
      }
      try {
        const jobs = await deps.api.claim({ workerId, max: Math.max(1, deps.config.concurrency - this.active.size) }, this.claimAbort.signal);
        for (const dispatch of jobs) this.pending.push(dispatch);
        this.schedule();
      } catch (err) {
        if (this.stopping) break;
        if (err instanceof WorkerAuthError) {
          this.fatal = err;
          this.stopping = true;
          break;
        }
        deps.logger.warn({ err: errorMessage(err) }, 'claim failed; backing off');
        await this.sleep(deps.claimErrorBackoffMs ?? 5_000);
      }
    }
  }

  /** Starts pending jobs whose task is idle while there are free slots. */
  private schedule(): void {
    const activeTasks = new Set([...this.active.values()].map((a) => a.job.taskId));
    const remaining: JobDispatch[] = [];
    for (const dispatch of this.pending) {
      const taskId = dispatch.job.taskId;
      if (this.active.size < this.deps.config.concurrency && !activeTasks.has(taskId) && !this.stopping) {
        activeTasks.add(taskId);
        this.launch(dispatch);
      } else {
        remaining.push(dispatch);
      }
    }
    this.pending = remaining;
  }

  private launch(dispatch: JobDispatch): void {
    const { job } = dispatch;
    if (this.active.has(job.id)) return;
    const controller = new AbortController();
    const running: RunningJob = { jobId: job.id, taskId: job.taskId, taskKeys: taskKeysOf(dispatch), startedAt: Date.now() };
    this.deps.logger.info({ jobId: job.id, taskId: job.taskId, kind: job.kind }, 'job started');
    const done = (async () => {
      try {
        await this.deps.runJob(dispatch, controller.signal);
      } catch (err) {
        this.deps.logger.error({ jobId: job.id, err: errorMessage(err) }, 'runJob threw');
      } finally {
        this.active.delete(job.id);
        this.deps.logger.info({ jobId: job.id, durationMs: Date.now() - running.startedAt }, 'job finished');
        void this.persistRunning();
        this.schedule();
        this.wakeSlot?.();
      }
    })();
    this.active.set(job.id, { job: running, controller, done });
    void this.persistRunning();
  }

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeSlot = () => {
        this.wakeSlot = null;
        resolve();
      };
    });
  }

  private startHeartbeat(): void {
    const interval = this.deps.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), interval);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeat(): Promise<void> {
    if (!this.workerId || this.stopping) return;
    try {
      await this.deps.api.heartbeat({ workerId: this.workerId, runningJobIds: [...this.active.keys()] });
    } catch (err) {
      if (err instanceof WorkerAuthError) {
        this.fatal = err;
        void this.stop('worker key rejected');
        return;
      }
      this.deps.logger.warn({ err: errorMessage(err) }, 'heartbeat failed');
    }
  }

  private async drain(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const reason = this.fatal ? 'worker key rejected' : SHUTDOWN_REASON;

    // Jobs claimed but never started must be released back as failures.
    const unstarted = this.pending;
    this.pending = [];
    await Promise.all(
      unstarted.map((d) =>
        this.deps.api.fail(d.job.id, reason).catch((err) => this.deps.logger.warn({ jobId: d.job.id, err: errorMessage(err) }, 'could not fail unstarted job')),
      ),
    );

    if (this.active.size > 0) {
      const grace = this.deps.shutdownGraceMs ?? 60_000;
      this.deps.logger.info({ running: this.active.size, graceMs: grace }, 'waiting for running jobs');
      const finished = await raceTimeout(
        Promise.all([...this.active.values()].map((a) => a.done)),
        grace,
        this.sleep,
      );
      if (!finished) {
        this.deps.logger.warn({ running: this.active.size }, 'grace period elapsed; killing running jobs');
        for (const entry of this.active.values()) entry.controller.abort(reason);
        await raceTimeout(Promise.all([...this.active.values()].map((a) => a.done)), 15_000, this.sleep);
      }
    }
    await this.persistRunning();
    this.onDrained?.();
  }

  private persistRunning(): Promise<void> {
    return this.persistence.saveRunning(this.running).catch((err) => this.deps.logger.warn({ err: errorMessage(err) }, 'could not persist running jobs'));
  }
}

async function raceTimeout(promise: Promise<unknown>, ms: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  let done = false;
  const marked = promise.then(() => {
    done = true;
  });
  await Promise.race([marked, sleep(ms)]);
  return done;
}
