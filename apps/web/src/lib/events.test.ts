import { describe, expect, it, vi } from 'vitest';
import { SseParser, parseServerEvent, subscribeToEvents } from './events';

describe('SseParser', () => {
  it('parses a complete data frame', () => {
    const parser = new SseParser();
    const frames = parser.feed('data: {"type":"ping"}\n\n');
    expect(frames).toEqual([{ event: 'message', data: '{"type":"ping"}' }]);
  });

  it('buffers partial lines across chunks', () => {
    const parser = new SseParser();
    expect(parser.feed('data: {"type":"task.upd')).toEqual([]);
    expect(parser.feed('ated","taskId":"t1"}\n')).toEqual([]);
    const frames = parser.feed('\n');
    expect(frames).toHaveLength(1);
    expect(parseServerEvent(frames[0]!)).toEqual({ type: 'task.updated', taskId: 't1' });
  });

  it('joins multi-line data, reads event/id fields and ignores comments', () => {
    const parser = new SseParser();
    const frames = parser.feed(': keep-alive\nevent: task\nid: 7\ndata: {"type":"task.created",\ndata: "taskId":"t2"}\n\n');
    expect(frames).toEqual([{ event: 'task', id: '7', data: '{"type":"task.created",\n"taskId":"t2"}' }]);
    expect(parseServerEvent(frames[0]!)).toEqual({ type: 'task.created', taskId: 't2' });
  });

  it('handles CRLF line endings and multiple frames in one chunk', () => {
    const parser = new SseParser();
    const frames = parser.feed('data: {"type":"ping"}\r\n\r\ndata: {"type":"worker.updated","workerId":"w1"}\r\n\r\n');
    expect(frames.map((f) => f.data)).toEqual(['{"type":"ping"}', '{"type":"worker.updated","workerId":"w1"}']);
  });

  it('flushes a trailing frame without a blank line', () => {
    const parser = new SseParser();
    expect(parser.feed('data: {"type":"ping"}')).toEqual([]);
    expect(parser.flush()).toEqual({ event: 'message', data: '{"type":"ping"}' });
  });

  it('returns null for malformed JSON payloads', () => {
    expect(parseServerEvent({ event: 'message', data: 'not json' })).toBeNull();
    expect(parseServerEvent({ event: 'message', data: '{"noType":true}' })).toBeNull();
  });
});

describe('subscribeToEvents', () => {
  it('sends the bearer token, emits parsed events and stops on abort', async () => {
    const onEvent = vi.fn();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer tok');
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"task.updated","taskId":"t1"}\n\n'));
          ctrl.close();
        },
      });
      // Abort after the first stream closes so we do not reconnect.
      queueMicrotask(() => controller.abort());
      return new Response(stream, { status: 200 });
    });
    await subscribeToEvents({
      onEvent,
      signal: controller.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseDelay: 1,
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'task.updated', taskId: 't1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
