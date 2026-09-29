import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { serviceUnavailable } from '../errors.js';
import type { SecretService } from './secrets.js';

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

const STATE_TTL_MS = 10 * 60_000;
const GITHUB_SCOPES = 'repo read:org';

export type GitHubOAuthReturnTo = 'web' | 'ios';

export type GitHubOAuthFailureReason = 'state' | 'credentials' | 'callback' | 'code' | 'scope' | 'account' | 'storage' | 'exchange';

export class GitHubOAuthError extends Error {
  constructor(
    readonly reason: GitHubOAuthFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitHubOAuthError';
  }
}

export class GitHubOAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly secrets: SecretService,
    private readonly fetchImpl: FetchLike,
  ) {}

  authorizationUrl(userId: string, returnTo: GitHubOAuthReturnTo = 'web'): string {
    const { clientId, callbackUrl } = this.credentials();
    const { state, codeChallenge } = this.createState(userId, returnTo);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: GITHUB_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'false',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async complete(code: string, state: string): Promise<{ userId: string; login: string }> {
    const { userId, codeVerifier } = this.verifyState(state);
    const { clientId, clientSecret, callbackUrl } = this.credentials();
    let tokenResponse: Response;
    let tokenBody: JsonObject;
    try {
      tokenResponse = await this.fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'sindral-server' },
        redirect: 'error',
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl, code_verifier: codeVerifier }),
      });
      tokenBody = await readJson(tokenResponse, 'GitHub OAuth token exchange');
    } catch (error) {
      throw new GitHubOAuthError('exchange', 'GitHub token exchange could not be completed', { cause: error });
    }
    const githubError = stringField(tokenBody, 'error');
    if (!tokenResponse.ok || githubError) {
      throw new GitHubOAuthError(tokenFailureReason(githubError), githubMessage(tokenBody, 'GitHub authorization failed'));
    }
    const token = stringField(tokenBody, 'access_token');
    if (!token) throw new GitHubOAuthError('exchange', githubMessage(tokenBody, 'GitHub authorization returned no access token'));
    const scopes = new Set(stringField(tokenBody, 'scope').split(/[\s,]+/).filter(Boolean));
    if (!scopes.has('repo')) throw new GitHubOAuthError('scope', 'GitHub authorization must grant repository access');

    let userResponse: Response;
    let userBody: JsonObject;
    try {
      userResponse = await this.fetchImpl('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sindral-server',
        },
        redirect: 'error',
      });
      userBody = await readJson(userResponse, 'GitHub user validation');
    } catch (error) {
      throw new GitHubOAuthError('account', 'GitHub account validation could not be completed', { cause: error });
    }
    if (!userResponse.ok) throw new GitHubOAuthError('account', githubMessage(userBody, 'GitHub could not validate the connected account'));
    const login = stringField(userBody, 'login');
    if (!login) throw new GitHubOAuthError('account', 'GitHub returned an invalid user profile');

    try {
      await this.secrets.set(userId, 'github', token, { source: 'oauth', login });
    } catch (error) {
      throw new GitHubOAuthError('storage', 'GitHub credential could not be stored', { cause: error });
    }
    return { userId, login };
  }

  callbackReturnTo(state: string | undefined): GitHubOAuthReturnTo {
    if (!state) return 'web';
    try {
      return this.verifyState(state).returnTo;
    } catch {
      return 'web';
    }
  }

  settingsRedirect(
    result: { connected?: boolean; error?: GitHubOAuthFailureReason | 'denied' | 'missing' },
    returnTo: GitHubOAuthReturnTo = 'web',
  ): string {
    const url = returnTo === 'ios' ? new URL('sindral://github/callback') : new URL('/settings', this.config.webOrigins[0]);
    if (result.connected) url.searchParams.set('github', 'connected');
    if (result.error) {
      url.searchParams.set('github', 'error');
      url.searchParams.set('github_error', result.error);
    }
    return url.toString();
  }

  private credentials(): { clientId: string; clientSecret: string; callbackUrl: string } {
    const clientId = this.config.githubOAuthClientId;
    const clientSecret = this.config.githubOAuthClientSecret;
    const callbackUrl = this.config.githubOAuthCallbackUrl;
    if (!clientId || !clientSecret || !callbackUrl) throw serviceUnavailable('GitHub repository authorization is not configured');
    return { clientId, clientSecret, callbackUrl };
  }

  private createState(userId: string, returnTo: GitHubOAuthReturnTo): { state: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.secretsEncryptionKey, iv);
    cipher.setAAD(Buffer.from('github-oauth-state\0'));
    const plaintext = JSON.stringify({ userId, expiresAt: Date.now() + STATE_TTL_MS, nonce: randomBytes(16).toString('hex'), codeVerifier, returnTo });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { state: `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`, codeChallenge };
  }

  private verifyState(state: string): { userId: string; codeVerifier: string; returnTo: GitHubOAuthReturnTo } {
    const [ivValue, ciphertextValue, tagValue, extra] = state.split('.');
    if (!ivValue || !ciphertextValue || !tagValue || extra) throw new GitHubOAuthError('state', 'Invalid GitHub authorization state');
    let parsed: unknown;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.config.secretsEncryptionKey, Buffer.from(ivValue, 'base64url'));
      decipher.setAAD(Buffer.from('github-oauth-state\0'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
      parsed = JSON.parse(plaintext) as unknown;
    } catch {
      throw new GitHubOAuthError('state', 'Invalid GitHub authorization state');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GitHubOAuthError('state', 'Invalid GitHub authorization state');
    const value = parsed as JsonObject;
    const userId = stringField(value, 'userId');
    const codeVerifier = stringField(value, 'codeVerifier');
    const expiresAt = value['expiresAt'];
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      throw new GitHubOAuthError('state', 'GitHub authorization state has expired');
    }
    return { userId, codeVerifier, returnTo: value['returnTo'] === 'ios' ? 'ios' : 'web' };
  }
}

async function readJson(response: Response, operation: string): Promise<JsonObject> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  } catch {
    // Handled below.
  }
  throw serviceUnavailable(`${operation} returned an invalid response`);
}

function stringField(value: JsonObject, key: string): string {
  return typeof value[key] === 'string' ? String(value[key]) : '';
}

function githubMessage(value: JsonObject, fallback: string): string {
  return stringField(value, 'error_description') || stringField(value, 'message') || stringField(value, 'error') || fallback;
}

function tokenFailureReason(error: string): GitHubOAuthFailureReason {
  if (error === 'incorrect_client_credentials') return 'credentials';
  if (error === 'redirect_uri_mismatch') return 'callback';
  if (error === 'bad_verification_code') return 'code';
  return 'exchange';
}
