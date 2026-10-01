import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../db/memory.js';
import { testConfig } from '../test/helpers.js';
import { GitHubOAuthService } from './githubOAuth.js';
import { SecretService } from './secrets.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GitHub OAuth credential rotation', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let repo: MemoryRepository;
  let secrets: SecretService;
  let oauth: GitHubOAuthService;
  let userId: string;

  beforeEach(() => {
    fetchMock.mockReset();
    repo = new MemoryRepository();
    const config = testConfig({
      githubOAuthClientId: 'github-client-id',
      githubOAuthClientSecret: 'github-client-secret',
      githubOAuthCallbackUrl: 'https://app.example.com/api/github/callback',
    });
    secrets = new SecretService(repo, config.secretsEncryptionKey);
    oauth = new GitHubOAuthService(config, secrets, fetchMock, () => NOW);
    userId = randomUUID();
  });

  it('rotates an expiring credential once across concurrent callers', async () => {
    await secrets.setCredential(userId, 'github', {
      token: 'github-access-old',
      refreshToken: 'github-refresh-old',
      expiresAt: new Date(NOW + 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(NOW + 86_400_000).toISOString(),
    }, { source: 'oauth', login: 'octocat' });
    fetchMock.mockResolvedValue(json({
      access_token: 'github-access-new',
      refresh_token: 'github-refresh-new',
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
      scope: 'repo,read:org',
      token_type: 'bearer',
    }));

    const [first, second] = await Promise.all([oauth.credential(userId), oauth.credential(userId)]);

    expect(first).toEqual(second);
    expect(first).toEqual({
      token: 'github-access-new',
      refreshToken: 'github-refresh-new',
      expiresAt: new Date(NOW + 28_800_000).toISOString(),
      refreshTokenExpiresAt: new Date(NOW + 15_897_600_000).toISOString(),
      metadata: { source: 'oauth', login: 'octocat' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      client_id: 'github-client-id',
      client_secret: 'github-client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'github-refresh-old',
    });

    const stored = await repo.getSecret(userId, 'github');
    expect(JSON.stringify(stored)).not.toContain('github-access-new');
    expect(JSON.stringify(stored)).not.toContain('github-refresh-new');
    expect(await oauth.credential(userId)).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires reconnect when the refresh token is expired or rejected', async () => {
    await secrets.setCredential(userId, 'github', {
      token: 'github-access-old',
      refreshToken: 'github-refresh-old',
      expiresAt: new Date(NOW - 1).toISOString(),
      refreshTokenExpiresAt: new Date(NOW - 1).toISOString(),
    }, { source: 'oauth' });
    await expect(oauth.credential(userId)).rejects.toMatchObject({ code: 'GITHUB_RECONNECT_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();

    await secrets.setCredential(userId, 'github', {
      token: 'github-access-old',
      refreshToken: 'github-refresh-old',
      expiresAt: new Date(NOW - 1).toISOString(),
      refreshTokenExpiresAt: new Date(NOW + 86_400_000).toISOString(),
    }, { source: 'oauth' });
    fetchMock.mockResolvedValue(json({ error: 'bad_refresh_token', error_description: 'The refresh token is invalid.' }, 400));
    await expect(oauth.credential(userId)).rejects.toMatchObject({ code: 'GITHUB_RECONNECT_REQUIRED' });
  });

  it('keeps legacy non-expiring OAuth tokens and PATs compatible', async () => {
    await secrets.set(userId, 'github', 'github-legacy-token', { source: 'oauth' });
    await expect(oauth.credential(userId)).resolves.toEqual({ token: 'github-legacy-token', metadata: { source: 'oauth' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
