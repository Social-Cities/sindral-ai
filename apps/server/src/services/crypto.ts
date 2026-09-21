import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const ALGORITHM = 'aes-256-gcm';

/** AES-256-GCM. `key` must be 32 bytes. Outputs are base64. */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  assertKey(key);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be exactly 32 bytes');
}

/** Non-sensitive display hint: last 4 characters, only for reasonably long secrets. */
export function secretHint(secret: string): string | null {
  return secret.length >= 8 ? secret.slice(-4) : null;
}

export const WORKER_KEY_PREFIX = 'sk_sindral_';
export const WORKER_KEY_RE = /^sk_sindral_[0-9a-f]{40}$/;
/** Length of the stored prefix shown in the UI (`sk_sindral_` + 7 hex chars). */
export const WORKER_KEY_PREFIX_LENGTH = 18;

export interface GeneratedWorkerKey {
  secret: string;
  hash: string;
  prefix: string;
}

export function hashWorkerKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateWorkerKey(): GeneratedWorkerKey {
  const secret = `${WORKER_KEY_PREFIX}${randomBytes(20).toString('hex')}`;
  return { secret, hash: hashWorkerKey(secret), prefix: secret.slice(0, WORKER_KEY_PREFIX_LENGTH) };
}

/** Constant-time string comparison (length differences still short-circuit, which leaks only the length). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
