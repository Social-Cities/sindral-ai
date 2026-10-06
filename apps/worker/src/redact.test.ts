import { describe, expect, it } from 'vitest';
import { errorMessage, Redactor } from './redact.js';
import { GH_TOKEN, WORKER_KEY } from './test/fixtures.js';

describe('Redactor', () => {
  it('removes registered secrets and known token shapes', () => {
    const r = new Redactor().add('super-secret-value', null, undefined, 'short');
    const githubPat = ['github', 'pat', '11ABCDEFG0123456789abcdefghij'].join('_');
    const text = `a super-secret-value b ${GH_TOKEN} c ${WORKER_KEY} d ${githubPat} e x-access-token:abc123@github.com short`;
    const out = r.redact(text);
    expect(out).not.toContain('super-secret-value');
    expect(out).not.toContain(GH_TOKEN);
    expect(out).not.toContain(WORKER_KEY);
    expect(out).not.toContain(githubPat);
    expect(out).not.toContain('x-access-token:abc123');
    // Values that are too short to be secrets are left alone to avoid mangling output.
    expect(out).toContain('short');
  });

  it('redacts basic auth headers as passed to git', () => {
    const header = `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from('x-access-token:abc').toString('base64')}`;
    expect(new Redactor().redact(header)).toBe('http.https://github.com/.extraheader=[redacted]');
  });

  it('redacts error messages', () => {
    const r = new Redactor().add(GH_TOKEN);
    expect(r.redactError(new Error(`failed with ${GH_TOKEN}`))).toBe('failed with [redacted]');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
  });
});
