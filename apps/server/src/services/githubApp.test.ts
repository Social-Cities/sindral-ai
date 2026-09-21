import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../test/helpers.js';
import { mintGitHubInstallationToken } from './githubApp.js';

describe('mintGitHubInstallationToken', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  it('requests a short-lived installation token scoped to unique repository names', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ token: 'ghs_short_lived', expires_at: '2026-09-21T12:10:00Z' }), { status: 201 }),
    );
    const config = testConfig({
      githubAppId: '12345',
      githubAppPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      githubAppInstallations: { [userId]: 67890 },
    });
    await expect(mintGitHubInstallationToken(config, userId, ['acme/app', 'acme/api', 'acme/app'], fetchImpl as typeof fetch)).resolves.toBe('ghs_short_lived');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/app/installations/67890/access_tokens');
    expect(JSON.parse(String(options?.body))).toEqual({ repositories: ['app', 'api'] });
    expect((options?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it('does not silently fall back when token exchange fails', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const config = testConfig({
      githubAppId: '12345',
      githubAppPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      githubAppInstallations: { [userId]: 67890 },
    });
    await expect(mintGitHubInstallationToken(config, userId, ['acme/app'], async () => new Response('{}', { status: 403 }))).rejects.toMatchObject({ statusCode: 503 });
  });
});
