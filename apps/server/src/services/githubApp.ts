import { importPKCS8, SignJWT } from 'jose';
import type { AppConfig } from '../config.js';
import { serviceUnavailable } from '../errors.js';

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

export function hasGitHubAppCredentials(config: AppConfig, userId: string): config is AppConfig & { githubAppId: string; githubAppPrivateKey: string } {
  return Boolean(config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallations[userId]);
}

/** Mint a short-lived installation token restricted to the repositories in one job. */
export async function mintGitHubInstallationToken(config: AppConfig, userId: string, repositories: string[], fetchImpl: typeof fetch): Promise<string> {
  if (!hasGitHubAppCredentials(config, userId)) throw serviceUnavailable('GitHub App credentials are not configured for this user');
  const installationId = config.githubAppInstallations[userId]!;
  const names = [...new Set(repositories.map((repository) => repository.split('/')[1]).filter((name): name is string => Boolean(name)))];
  if (names.length === 0) throw serviceUnavailable('The job does not identify a repository for GitHub App access');
  const key = await importPKCS8(config.githubAppPrivateKey, 'RS256').catch(() => {
    throw serviceUnavailable('GitHub App private key is invalid');
  });
  const now = Math.floor(Date.now() / 1_000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(config.githubAppId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'sindral-server',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ repositories: names }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw serviceUnavailable(`GitHub App token exchange failed with ${response.status}`);
  const body = (await response.json()) as InstallationTokenResponse;
  if (typeof body.token !== 'string' || body.token.length === 0) throw serviceUnavailable('GitHub App token exchange returned no token');
  return body.token;
}
