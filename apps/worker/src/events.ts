import type { ApiClient, JobEvent } from './api.js';
import type { Logger } from './logger.js';
import type { Redactor } from './redact.js';

export const MAX_EVENT_CHARS = 20_000;
const FLUSH_LINES = 50;
const FLUSH_INTERVAL_MS = 2_000;

export interface EventSink {
  postEvent(jobId: string, event: JobEvent): Promise<unknown>;
}

/**
 * Batches agent log lines into `log` events (every 2s or 50 lines, at most
 * 20k characters per event). Progress/message events are sent immediately,
 * after any buffered logs so ordering is preserved. Delivery failures are
 * logged and swallowed: losing a log line must never fail a job.
 */
export class JobEventStream {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly api: EventSink | Pick<ApiClient, 'postEvent'>,
    private readonly jobId: string,
    private readonly attempt: number,
    private readonly leaseToken: string,
    private readonly redactor: Redactor,
    private readonly log: Logger,
    private readonly flushIntervalMs: number = FLUSH_INTERVAL_MS,
  ) {}

  line(line: string): void {
    if (this.closed) return;
    this.buffer.push(this.redactor.redact(line));
    if (this.buffer.length >= FLUSH_LINES) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  progress(message: string): void {
    this.emit('progress', message);
  }

  message(message: string): void {
    this.emit('message', message);
  }

  private emit(type: JobEvent['type'], message: string): void {
    if (this.closed) return;
    this.flush();
    this.enqueue({ type, message: truncate(this.redactor.redact(message)), attempt: this.attempt, leaseToken: this.leaseToken });
  }

  /** Sends whatever is buffered right now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    for (const chunk of chunkLines(lines)) this.enqueue({ type: 'log', message: chunk, attempt: this.attempt, leaseToken: this.leaseToken });
  }

  /** Flushes and waits for in-flight deliveries. */
  async close(): Promise<void> {
    this.flush();
    this.closed = true;
    await this.chain;
  }

  private enqueue(event: JobEvent): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.api.postEvent(this.jobId, event);
      } catch (err) {
        this.log.warn({ jobId: this.jobId, type: event.type, err: this.redactor.redactError(err) }, 'failed to post job event');
      }
    });
  }
}

function truncate(text: string): string {
  return text.length <= MAX_EVENT_CHARS ? text : `${text.slice(0, MAX_EVENT_CHARS - 15)}\n...[truncated]`;
}

/** Joins lines into newline-separated chunks that each fit in one event. */
export function chunkLines(lines: string[], limit: number = MAX_EVENT_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const rawLine of lines) {
    const line = rawLine.length > limit ? `${rawLine.slice(0, limit - 15)}...[truncated]` : rawLine;
    if (current.length > 0 && current.length + 1 + line.length > limit) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}
