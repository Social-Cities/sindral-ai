import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `apps/server`, whether running from `src/` (tsx) or `dist/`. */
export const SERVER_PACKAGE_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_PACKAGE_DIR, '..', '..');

const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: optionalString,
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().min(1).default('0.0.0.0'),
  WEB_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes hex encoded (openssl rand -hex 32)'),
  GITHUB_WEBHOOK_SECRET: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_DIST_DIR: optionalString,
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseJwtSecret: string | undefined;
  port: number;
  host: string;
  webOrigins: string[];
  secretsEncryptionKey: Buffer;
  githubWebhookSecret: string | undefined;
  logLevel: LogLevel;
  webDistDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example at the repository root.`);
  }
  const e = result.data;
  return {
    supabaseUrl: e.SUPABASE_URL,
    supabaseAnonKey: e.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    supabaseJwtSecret: e.SUPABASE_JWT_SECRET,
    port: e.PORT,
    host: e.HOST,
    webOrigins: e.WEB_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    secretsEncryptionKey: Buffer.from(e.SECRETS_ENCRYPTION_KEY, 'hex'),
    githubWebhookSecret: e.GITHUB_WEBHOOK_SECRET,
    logLevel: e.LOG_LEVEL,
    webDistDir: e.WEB_DIST_DIR ?? path.resolve(SERVER_PACKAGE_DIR, '..', 'web', 'dist'),
  };
}

/** Load `.env` from the repo root and the cwd (existing process env wins), then validate. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  for (const dir of [REPO_ROOT, process.cwd()]) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
  }
  return parseConfig(env);
}
