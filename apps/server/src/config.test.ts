import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config.js';

const valid = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  SECRETS_ENCRYPTION_KEY: 'ab'.repeat(32),
  WEB_ORIGIN: 'http://localhost:5173, https://app.example.com',
  SUPABASE_JWT_SECRET: '',
};

describe('config', () => {
  it('parses and applies defaults', () => {
    const config = parseConfig(valid);
    expect(config.port).toBe(8787);
    expect(config.host).toBe('0.0.0.0');
    expect(config.webOrigins).toEqual(['http://localhost:5173', 'https://app.example.com']);
    expect(config.supabaseJwtSecret).toBeUndefined();
    expect(config.secretsEncryptionKey).toHaveLength(32);
    expect(config.webDistDir.endsWith('/apps/web/dist')).toBe(true);
    expect(parseConfig({ ...valid, WEB_DIST_DIR: '/srv/web' }).webDistDir).toBe('/srv/web');
  });

  it('fails fast with a readable message', () => {
    expect(() => parseConfig({ ...valid, SECRETS_ENCRYPTION_KEY: 'short', PORT: 'abc' })).toThrow(ConfigError);
    try {
      parseConfig({ ...valid, SECRETS_ENCRYPTION_KEY: 'short' });
    } catch (err) {
      expect((err as Error).message).toContain('SECRETS_ENCRYPTION_KEY');
      expect((err as Error).message).toContain('openssl rand -hex 32');
    }
    expect(() => parseConfig({ ...valid, GITHUB_APP_ID: '1' })).toThrow(/configured together/);
  });
});
