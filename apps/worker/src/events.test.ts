import { describe, expect, it, vi } from 'vitest';
import type { JobEvent } from './api.js';
import { chunkLines, JobEventStream, MAX_EVENT_CHARS } from './events.js';
import { silentLogger } from './logger.js';
import { Redactor } from './redact.js';
import { GH_TOKEN } from './test/fixtures.js';

function sink() {
  const events: JobEvent[] = [];
  return { events, postEvent: vi.fn(async (_id: string, e: JobEvent) => void events.push(e)) };
}

describe('JobEventStream', () => {
  it('batches log lines, flushes at 50 lines and on close, and redacts', async () => {
    const api = sink();
    const stream = new JobEventStream(api, 'job', new Redactor(), silentLogger(), 1_000_000);
    for (let i = 0; i < 60; i++) stream.line(i === 3 ? `token ${GH_TOKEN}` : `line ${i}`);
    await new Promise((r) => setImmediate(r));
    expect(api.events).toHaveLength(1);
    expect(api.events[0]?.message.split('\n')).toHaveLength(50);
    expect(api.events[0]?.message).not.toContain(GH_TOKEN);
    await stream.close();
    expect(api.events).toHaveLength(2);
    expect(api.events[1]?.message.split('\n')).toHaveLength(10);
  });

  it('flushes on a timer', async () => {
    const api = sink();
    const stream = new JobEventStream(api, 'job', new Redactor(), silentLogger(), 5);
    stream.line('a');
    await new Promise((r) => setTimeout(r, 20));
    expect(api.events).toEqual([{ type: 'log', message: 'a' }]);
    await stream.close();
  });

  it('sends progress immediately, after any buffered logs', async () => {
    const api = sink();
    const stream = new JobEventStream(api, 'job', new Redactor(), silentLogger(), 1_000_000);
    stream.line('first');
    stream.progress('halfway');
    stream.message('note');
    await stream.close();
    expect(api.events.map((e) => e.type)).toEqual(['log', 'progress', 'message']);
    expect(api.events[1]?.message).toBe('halfway');
  });

  it('swallows delivery failures', async () => {
    const api = { postEvent: vi.fn(async () => { throw new Error('offline'); }) };
    const stream = new JobEventStream(api, 'job', new Redactor(), silentLogger(), 1_000_000);
    stream.progress('x');
    await expect(stream.close()).resolves.toBeUndefined();
  });

  it('caps each event at 20k characters', () => {
    const big = 'x'.repeat(15_000);
    const chunks = chunkLines([big, big, 'small']);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length <= MAX_EVENT_CHARS)).toBe(true);
    expect(chunks[1]).toBe(`${big}\nsmall`);
    const huge = chunkLines(['y'.repeat(25_000)]);
    expect(huge[0]?.length).toBeLessThanOrEqual(MAX_EVENT_CHARS);
    expect(huge[0]?.endsWith('[truncated]')).toBe(true);
  });
});
