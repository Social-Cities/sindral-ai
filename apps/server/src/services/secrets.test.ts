import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../db/memory.js';
import { SecretService } from './secrets.js';

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
});
