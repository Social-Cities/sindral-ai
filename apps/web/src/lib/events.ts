import type { ServerEvent } from '@sindral/shared';
import { API_BASE } from './api';
import { getAccessToken } from './supabase';

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for the text/event-stream format. Feed it chunks of
 * text; it returns complete frames as they are delimited by blank lines.
 * Comment lines (starting with `:`) are ignored; multi-line `data:` fields
 * are joined with `\n` per the spec.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let idx: number;
    // Process complete lines only; keep the trailing partial line in the buffer.
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const frame = this.processLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flush any buffered frame (e.g. when the stream closes without a trailing blank line). */
  flush(): SseFrame | null {
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      this.processLine(line);
    }
    return this.dispatch();
  }

  private processLine(line: string): SseFrame | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        this.id = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    if (this.data.length === 0) {
      this.event = '';
      return null;
    }
    const frame: SseFrame = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.id !== undefined) frame.id = this.id;
    this.event = '';
    this.data = [];
    return frame;
  }
}

function isServerEvent(value: unknown): value is ServerEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Parse a frame's JSON payload into a ServerEvent, or null when malformed. */
export function parseServerEvent(frame: SseFrame): ServerEvent | null {
  try {
    const parsed: unknown = JSON.parse(frame.data);
    return isServerEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface SubscribeOptions {
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
  signal: AbortSignal;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string | null>;
  path?: string;
  /** Initial reconnect delay in ms; doubles up to `maxDelay`. */
  baseDelay?: number;
  maxDelay?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Subscribe to `GET /api/events` with an Authorization header (EventSource
 * cannot set headers). Reconnects with exponential backoff until the signal
 * is aborted.
 */
export async function subscribeToEvents(options: SubscribeOptions): Promise<void> {
  const {
    onEvent,
    onStatus,
    signal,
    fetchImpl = fetch,
    getToken = getAccessToken,
    path = '/api/events',
    baseDelay = 1000,
    maxDelay = 30_000,
  } = options;
  let delay = baseDelay;

  while (!signal.aborted) {
    onStatus?.('connecting');
    try {
      const token = await getToken();
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const res = await fetchImpl(`${API_BASE}${path}`, { headers, signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`SSE connection failed with status ${res.status}`);
      onStatus?.('open');
      delay = baseDelay;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          const event = parseServerEvent(frame);
          if (event) onEvent(event);
        }
      }
      const last = parser.flush();
      if (last) {
        const event = parseServerEvent(last);
        if (event) onEvent(event);
      }
    } catch {
      // fall through to reconnect
    }
    onStatus?.('closed');
    if (signal.aborted) break;
    await sleep(delay, signal);
    delay = Math.min(delay * 2, maxDelay);
  }
}
