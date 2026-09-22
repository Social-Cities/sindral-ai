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
    expect(config.environment).toBe('development');
    expect(config.port).toBe(8787);
    expect(config.host).toBe('0.0.0.0');
    expect(config.webOrigins).toEqual(['http://localhost:5173', 'https://app.example.com']);
    expect(config.supabaseJwtSecret).toBeUndefined();
    expect(config.secretsEncryptionKey).toHaveLength(32);
    expect(config.webDistDir.endsWith('/apps/web/dist')).toBe(true);
    expect(config.githubAppInstallations).toEqual({});
    expect(config.jobDispatchEnabled).toBe(true);
    expect(config.autoMergeEnabled).toBe(false);
    expect(parseConfig({ ...valid, SINDRAL_JOB_DISPATCH_ENABLED: 'false', SINDRAL_AUTO_MERGE_ENABLED: 'true' })).toMatchObject({
      jobDispatchEnabled: false,
      autoMergeEnabled: true,
    });
    expect(parseConfig({ ...valid, WEB_DIST_DIR: '/srv/web' }).webDistDir).toBe('/srv/web');
    expect(
      parseConfig({
        ...valid,
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: 'key',
        GITHUB_APP_INSTALLATIONS: '{"11111111-1111-4111-8111-111111111111":456}',
      }).githubAppInstallations,
    ).toEqual({ '11111111-1111-4111-8111-111111111111': 456 });
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
    expect(() => parseConfig({ ...valid, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'key', GITHUB_APP_INSTALLATIONS: '[]' })).toThrow(/JSON object/);
    expect(() => parseConfig({ ...valid, SINDRAL_JOB_DISPATCH_ENABLED: 'yes' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, WEB_ORIGIN: 'https://app.example.com/path' })).toThrow(/exact HTTP\(S\) origins/);
    expect(() => parseConfig({
      ...valid,
      SINDRAL_ENV: 'production',
      SUPABASE_URL: 'https://project.supabase.co',
      WEB_ORIGIN: 'https://app.example.com',
      GITHUB_WEBHOOK_SECRET: 'x'.repeat(32),
    })).not.toThrow();
    expect(() => parseConfig({ ...valid, SINDRAL_ENV: 'production' })).toThrow(/SUPABASE_URL must use HTTPS/);
    expect(() => parseConfig({ ...valid, SINDRAL_ENV: 'production', SUPABASE_URL: 'https://project.supabase.co' })).toThrow(/WEB_ORIGIN must use HTTPS/);
    expect(() => parseConfig({ ...valid, SINDRAL_ENV: 'production', SUPABASE_URL: 'https://project.supabase.co', WEB_ORIGIN: 'https://app.example.com' })).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });
});
