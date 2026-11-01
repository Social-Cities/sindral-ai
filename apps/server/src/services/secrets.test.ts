import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../db/memory.js';
import { SecretService } from './secrets.js';
import { encryptSecret } from './crypto.js';

const key = Buffer.from('ab'.repeat(32), 'hex');
const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz'].join('_');

describe('SecretService', () => {
  it('trims manually stored tokens before encrypting them', async () => {
    const secrets = new SecretService(new MemoryRepository(), key);
    const userId = randomUUID();

    await secrets.set(userId, 'github', `  ${githubToken}\n`, { source: 'pat' });

    await expect(secrets.get(userId, 'github')).resolves.toMatchObject({
      token: githubToken,
      metadata: { source: 'pat' },
    });
  });

  it('trims structured OAuth credentials before encrypting them', async () => {
    const secrets = new SecretService(new MemoryRepository(), key);
    const userId = randomUUID();

    await secrets.setCredential(userId, 'github', {
      token: '  ghu_access\n',
      refreshToken: '  ghr_refresh\n',
      expiresAt: '  2026-10-02T12:00:00.000Z  ',
    });

    await expect(secrets.get(userId, 'github')).resolves.toMatchObject({
      token: 'ghu_access',
      refreshToken: 'ghr_refresh',
      expiresAt: '2026-10-02T12:00:00.000Z',
    });
  });

  it.each(['wrong encryption key', 'damaged ciphertext', 'invalid structured credential'])('reports an unreadable credential for %s without deleting it', async (failure) => {
    const repo = new MemoryRepository();
    const userId = randomUUID();
    const plaintext = failure === 'invalid structured credential' ? 'sindral-credential:v1:{broken' : 'lin_api_private';
    const encryptionKey = failure === 'wrong encryption key' ? Buffer.from('cd'.repeat(32), 'hex') : key;
    const encrypted = encryptSecret(plaintext, encryptionKey);
    if (failure === 'damaged ciphertext') encrypted.authTag = Buffer.alloc(16).toString('base64');
    const stored = await repo.upsertSecret(userId, 'linear', { ...encrypted, hint: null, metadata: {} });
    const secrets = new SecretService(repo, key);

    await expect(secrets.get(userId, 'linear')).rejects.toMatchObject({
      statusCode: 400,
      code: 'CREDENTIAL_UNREADABLE',
      message: 'The saved Linear credential could not be read. Save it again in Settings and retry.',
    });
    await expect(repo.getSecret(userId, 'linear')).resolves.toEqual(stored);
    await expect(secrets.get(randomUUID(), 'linear')).resolves.toBeNull();
  });

  it('preserves repository failures instead of asking the user to replace a valid credential', async () => {
    const repo = new MemoryRepository();
    const failure = new Error('Database unavailable');
    vi.spyOn(repo, 'getSecret').mockRejectedValueOnce(failure);
    const secrets = new SecretService(repo, key);

    await expect(secrets.get(randomUUID(), 'linear')).rejects.toBe(failure);
  });
});
