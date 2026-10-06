import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateWorkerKey, hashWorkerKey, safeEqual, secretHint, WORKER_KEY_RE } from './crypto.js';

const key = Buffer.from('ab'.repeat(32), 'hex');
const githubToken = ['ghp', 'supersecret'].join('_');
const githubTokenWithHint = ['ghp', 'abcdefgh1234'].join('_');

describe('secret encryption', () => {
  it('round-trips with AES-256-GCM and unique ivs', () => {
    const a = encryptSecret(githubToken, key);
    const b = encryptSecret(githubToken, key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(decryptSecret(a, key)).toBe(githubToken);
    expect(decryptSecret(b, key)).toBe(githubToken);
  });

  it('fails on tampering or a wrong key', () => {
    const enc = encryptSecret('token', key);
    expect(() => decryptSecret({ ...enc, authTag: Buffer.alloc(16).toString('base64') }, key)).toThrow();
    expect(() => decryptSecret(enc, Buffer.from('cd'.repeat(32), 'hex'))).toThrow();
    expect(() => encryptSecret('x', Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('hints only the last four characters', () => {
    expect(secretHint(githubTokenWithHint)).toBe('1234');
    expect(secretHint('short')).toBeNull();
  });
});

describe('worker keys', () => {
  it('generates prefixed keys with sha256 hashes', () => {
    const k = generateWorkerKey();
    expect(k.secret).toMatch(WORKER_KEY_RE);
    expect(k.prefix).toBe(k.secret.slice(0, 18));
    expect(k.hash).toBe(hashWorkerKey(k.secret));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWorkerKey().secret).not.toBe(k.secret);
  });

  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
