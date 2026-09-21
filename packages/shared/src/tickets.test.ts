import { describe, expect, it } from 'vitest';
import { detectTicket, normalizeRepo } from './tickets.js';

describe('detectTicket', () => {
  it('detects linear, jira and github issue urls', () => {
    expect(detectTicket('https://linear.app/acme/issue/ENG-142/some-title')).toEqual({ provider: 'linear', id: 'ENG-142', ref: { org: 'acme' } });
    expect(detectTicket('https://acme.atlassian.net/browse/VAN-12')).toEqual({ provider: 'jira', id: 'VAN-12', ref: { host: 'acme.atlassian.net' } });
    expect(detectTicket('https://github.com/acme/repo/issues/7')).toEqual({ provider: 'github', id: 'repo#7', ref: { owner: 'acme', repo: 'repo', number: 7 } });
  });

  it('rejects look-alike hosts and unrelated urls (SSRF guard)', () => {
    expect(detectTicket('https://linear.app.evil.com/acme/issue/ENG-1')).toBeNull();
    expect(detectTicket('https://evil.com/browse/VAN-12')).toBeNull();
    expect(detectTicket('http://github.com/acme/repo/issues/7')).toBeNull();
    expect(detectTicket('https://github.com/acme/repo/pull/7')).toBeNull();
    expect(detectTicket('not a url')).toBeNull();
  });
});

describe('normalizeRepo', () => {
  it('normalises different repo spellings', () => {
    expect(normalizeRepo('acme/repo')).toBe('acme/repo');
    expect(normalizeRepo('https://github.com/acme/repo.git')).toBe('acme/repo');
    expect(normalizeRepo('github.com/acme/repo/')).toBe('acme/repo');
  });
  it('rejects invalid input', () => {
    expect(normalizeRepo('acme')).toBeNull();
    expect(normalizeRepo('../etc/passwd')).toBeNull();
    expect(normalizeRepo('acme/repo/extra')).toBeNull();
  });
});
