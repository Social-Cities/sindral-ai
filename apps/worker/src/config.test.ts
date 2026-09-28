import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, expandHome, loadConfig, userConfigFile, workdirPaths } from './config.js';
import { WORKER_KEY } from './test/fixtures.js';

const base = { SINDRAL_SERVER_URL: 'http://localhost:8787/', SINDRAL_WORKER_KEY: WORKER_KEY };
const opts = { home: '/home/dev', hostname: 'devbox' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base, opts);
    expect(config.serverUrl).toBe('http://localhost:8787');
    expect(config.workdir).toBe(path.resolve('/home/dev/.sindral'));
    expect(config.concurrency).toBe(2);
    expect(config.workerName).toBe('devbox');
    expect(config.claudeBin).toBe('claude');
    expect(config.codexBin).toBe('codex');
    expect(config.ghBin).toBe('gh');
    expect(config.jobTimeoutMs).toBe(90 * 60_000);
    expect(config.retentionMs).toBe(7 * 24 * 60 * 60_000);
    expect(config.allowPatMerge).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('expands ~ in the workdir', () => {
    expect(expandHome('~/x', '/home/dev')).toBe('/home/dev/x');
    expect(expandHome('~', '/home/dev')).toBe('/home/dev');
    expect(expandHome('/abs', '/home/dev')).toBe('/abs');
    const config = loadConfig({ ...base, SINDRAL_WORKDIR: '~/work/sindral' }, opts);
    expect(config.workdir).toBe(path.resolve('/home/dev/work/sindral'));
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ ...base, SINDRAL_WORKER_NAME: '', SINDRAL_CONCURRENCY: '' }, opts);
    expect(config.workerName).toBe('devbox');
    expect(config.concurrency).toBe(2);
  });

  it('parses numeric and named settings', () => {
    const config = loadConfig(
      { ...base, SINDRAL_CONCURRENCY: '4', SINDRAL_JOB_TIMEOUT_MINUTES: '15', SINDRAL_RETENTION_DAYS: '30', SINDRAL_WORKER_NAME: 'mac', LOG_LEVEL: 'debug', SINDRAL_CLAUDE_BIN: '/opt/claude', SINDRAL_ALLOW_PAT_MERGE: 'true' },
      opts,
    );
    expect(config.concurrency).toBe(4);
    expect(config.jobTimeoutMs).toBe(15 * 60_000);
    expect(config.retentionMs).toBe(30 * 24 * 60 * 60_000);
    expect(config.workerName).toBe('mac');
    expect(config.logLevel).toBe('debug');
    expect(config.claudeBin).toBe('/opt/claude');
    expect(config.allowPatMerge).toBe(true);
  });

  it('rejects a malformed worker key', () => {
    expect(() => loadConfig({ ...base, SINDRAL_WORKER_KEY: 'nope' }, opts)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SINDRAL_WORKER_KEY: 'nope' }, opts)).toThrow(/SINDRAL_WORKER_KEY/);
  });

  it('rejects missing or invalid values', () => {
    expect(() => loadConfig({ SINDRAL_WORKER_KEY: WORKER_KEY }, opts)).toThrow(/SINDRAL_SERVER_URL/);
    expect(() => loadConfig({ ...base, SINDRAL_SERVER_URL: 'not a url' }, opts)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SINDRAL_CONCURRENCY: '9' }, opts)).toThrow(/SINDRAL_CONCURRENCY/);
    expect(() => loadConfig({ ...base, SINDRAL_CONCURRENCY: '0' }, opts)).toThrow(/SINDRAL_CONCURRENCY/);
    expect(() => loadConfig({ ...base, SINDRAL_RETENTION_DAYS: '-1' }, opts)).toThrow(/SINDRAL_RETENTION_DAYS/);
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' }, opts)).toThrow(/LOG_LEVEL/);
  });

  it('derives workdir sub-paths', () => {
    const paths = workdirPaths('/w');
    expect(paths.repos).toBe(path.join('/w', 'repos'));
    expect(paths.worktrees).toBe(path.join('/w', 'worktrees'));
    expect(paths.workerFile).toBe(path.join('/w', 'worker.json'));
    expect(userConfigFile('/home/dev')).toBe(path.join('/home/dev', '.sindral', 'config.json'));
  });
});
