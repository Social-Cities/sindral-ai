import type { SecretProvider, SecretStatus } from '@sindral/shared';
import type { Repository } from '../db/repository.js';
import { decryptSecret, encryptSecret, secretHint } from './crypto.js';

export const SECRET_PROVIDERS: SecretProvider[] = ['github', 'linear', 'jira'];

export interface DecryptedSecret {
  token: string;
  metadata: Record<string, unknown>;
}

export class SecretService {
  constructor(
    private readonly repo: Repository,
    private readonly key: Buffer,
  ) {}

  async set(userId: string, provider: SecretProvider, token: string, metadata: Record<string, unknown> = {}): Promise<SecretStatus> {
    const encrypted = encryptSecret(token, this.key);
    const stored = await this.repo.upsertSecret(userId, provider, { ...encrypted, hint: secretHint(token), metadata });
    return { provider, configured: true, updatedAt: stored.updatedAt, hint: stored.hint };
  }

  async get(userId: string, provider: SecretProvider): Promise<DecryptedSecret | null> {
    const stored = await this.repo.getSecret(userId, provider);
    if (!stored) return null;
    return { token: decryptSecret(stored, this.key), metadata: stored.metadata };
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
