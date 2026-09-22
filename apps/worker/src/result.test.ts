import { describe, expect, it } from 'vitest';
import { Redactor } from './redact.js';
import { describeFailure, extractJsonCandidate, parseRawResult, summaryOf, validateResult } from './result.js';
import { GH_TOKEN, WORKER_KEY } from './test/fixtures.js';

describe('parseRawResult', () => {
  it('fills in the kind from the step when missing', () => {
    const parsed = parseRawResult('{"summary":"s","plan":"p"}', 'plan');
    expect(parsed).toEqual({ ok: true, value: { kind: 'plan', summary: 's', plan: 'p' } });
  });

  it('keeps an explicit kind', () => {
    const parsed = parseRawResult('{"kind":"review","summary":"s"}', 'plan');
    expect(parsed.ok && parsed.value.kind).toBe('review');
  });

  it('tolerates a fenced JSON block', () => {
    const parsed = parseRawResult('```json\n{"summary":"s"}\n```', 'pr');
    expect(parsed).toEqual({ ok: true, value: { kind: 'pr', summary: 's' } });
  });

  it('reports missing, empty, invalid and non-object files', () => {
    expect(parseRawResult(null, 'plan')).toEqual({ ok: false, reason: 'the agent did not write the result file' });
    expect(parseRawResult('   ', 'plan')).toEqual({ ok: false, reason: 'the result file is empty' });
    const bad = parseRawResult('{nope', 'plan');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toMatch(/not valid JSON/);
    const arr = parseRawResult('[1]', 'plan');
    expect(!arr.ok && arr.reason).toMatch(/not a JSON object/);
  });
});

describe('validateResult', () => {
  it('accepts a well-formed result', () => {
    const v = validateResult({ kind: 'verdict', summary: 's', report: 'r', verdict: 'GO' });
    expect(v.ok).toBe(true);
  });

  it('explains schema violations', () => {
    const v = validateResult({ kind: 'plan', summary: 's' });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/plan/);
    const unknown = validateResult({ kind: 'mystery', summary: 's' });
    expect(unknown.ok).toBe(false);
  });

  it('allows only bounded text artifact payloads', () => {
    const unsupported = validateResult({
      kind: 'document', summary: 's', artifacts: [{ name: 'payload.bin', contentType: 'application/octet-stream', content: 'data' }],
    });
    expect(unsupported.ok).toBe(false);

    const oversizedUtf8 = validateResult({
      kind: 'document', summary: 's', artifacts: [{ name: 'large.txt', contentType: 'text/plain', content: 'é'.repeat(500_001) }],
    });
    expect(oversizedUtf8.ok).toBe(false);
    expect(!oversizedUtf8.ok && oversizedUtf8.reason).toMatch(/byte limit/);
  });

  it('extracts summaries', () => {
    expect(summaryOf({ summary: '  hi ' })).toBe('hi');
    expect(summaryOf({ summary: '' })).toBeNull();
    expect(summaryOf({})).toBeNull();
  });
});

describe('extractJsonCandidate', () => {
  it('finds a fenced or bare JSON object with a summary in free text', () => {
    expect(extractJsonCandidate('Here you go:\n```json\n{"summary":"s","plan":"p"}\n```\nDone.')).toBe('{"summary":"s","plan":"p"}');
    expect(extractJsonCandidate('Result: {"kind":"review","summary":"s","report":"r {nested}"} trailing')).toBe('{"kind":"review","summary":"s","report":"r {nested}"}');
    expect(extractJsonCandidate('no json here')).toBeNull();
    expect(extractJsonCandidate('{"not":"a result"}')).toBeNull();
    expect(extractJsonCandidate(null)).toBeNull();
  });
});

describe('describeFailure', () => {
  it('includes the agent output tail and redacts secrets', () => {
    const redactor = new Redactor().add(WORKER_KEY, 'my-secret-value');
    const message = describeFailure('the agent did not write the result file', ['line 1', `token ${GH_TOKEN}`, `key ${WORKER_KEY}`, 'my-secret-value here'], redactor);
    expect(message).toContain('Agent finished but the agent did not write the result file.');
    expect(message).toContain('Last 4 lines of agent output:');
    expect(message).toContain('  line 1');
    expect(message).not.toContain(GH_TOKEN);
    expect(message).not.toContain(WORKER_KEY);
    expect(message).not.toContain('my-secret-value');
    expect(message).toContain('[redacted]');
  });

  it('omits the tail section when there is no output', () => {
    expect(describeFailure('x', [], new Redactor())).toBe('Agent finished but x.');
  });
});
