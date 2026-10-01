import type { SecretProvider, SecretStatus } from '@sindral/shared';
import type { Repository } from '../db/repository.js';
import { decryptSecret, encryptSecret, secretHint } from './crypto.js';

export const SECRET_PROVIDERS: SecretProvider[] = ['github', 'linear', 'jira'];

export interface DecryptedSecret {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
  metadata: Record<string, unknown>;
}

export interface SecretCredential {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
}

const CREDENTIAL_PREFIX = 'sindral-credential:v1:';

export class SecretService {
  constructor(
    private readonly repo: Repository,
    private readonly key: Buffer,
  ) {}

  async set(userId: string, provider: SecretProvider, token: string, metadata: Record<string, unknown> = {}): Promise<SecretStatus> {
    return this.store(userId, provider, token, token, metadata);
  }

  async setCredential(userId: string, provider: SecretProvider, credential: SecretCredential, metadata: Record<string, unknown> = {}): Promise<SecretStatus> {
    if (!credential.token) throw new Error('A credential token is required');
    const plaintext = `${CREDENTIAL_PREFIX}${JSON.stringify(credential)}`;
    return this.store(userId, provider, plaintext, credential.token, metadata);
  }

  private async store(userId: string, provider: SecretProvider, plaintext: string, hintToken: string, metadata: Record<string, unknown>): Promise<SecretStatus> {
    const encrypted = encryptSecret(plaintext, this.key);
    const stored = await this.repo.upsertSecret(userId, provider, { ...encrypted, hint: secretHint(hintToken), metadata });
    return { provider, configured: true, updatedAt: stored.updatedAt, hint: stored.hint };
  }

  async get(userId: string, provider: SecretProvider): Promise<DecryptedSecret | null> {
    const stored = await this.repo.getSecret(userId, provider);
    if (!stored) return null;
    const plaintext = decryptSecret(stored, this.key);
    if (!plaintext.startsWith(CREDENTIAL_PREFIX)) return { token: plaintext, metadata: stored.metadata };
    const credential = parseCredential(plaintext.slice(CREDENTIAL_PREFIX.length));
    return { ...credential, metadata: stored.metadata };
  }

  async statuses(userId: string): Promise<SecretStatus[]> {
    const stored = await this.repo.listSecrets(userId);
    return SECRET_PROVIDERS.map((provider) => {
      const s = stored.find((x) => x.provider === provider);
      return s ? { provider, configured: true, updatedAt: s.updatedAt, hint: s.hint } : { provider, configured: false, updatedAt: null, hint: null };
    });
  }

  async remove(userId: string, provider: SecretProvider): Promise<void> {
    await this.repo.deleteSecret(userId, provider);
  }
}

function parseCredential(value: string): SecretCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Stored credential is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored credential is invalid');
  const credential = parsed as Record<string, unknown>;
  if (typeof credential['token'] !== 'string' || !credential['token']) throw new Error('Stored credential is invalid');
  for (const field of ['refreshToken', 'expiresAt', 'refreshTokenExpiresAt']) {
    if (credential[field] !== undefined && typeof credential[field] !== 'string') throw new Error('Stored credential is invalid');
  }
  return {
    token: credential['token'],
    ...(typeof credential['refreshToken'] === 'string' ? { refreshToken: credential['refreshToken'] } : {}),
    ...(typeof credential['expiresAt'] === 'string' ? { expiresAt: credential['expiresAt'] } : {}),
    ...(typeof credential['refreshTokenExpiresAt'] === 'string' ? { refreshTokenExpiresAt: credential['refreshTokenExpiresAt'] } : {}),
  };
}
