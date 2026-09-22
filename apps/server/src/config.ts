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
const booleanString = (defaultValue: 'true' | 'false') => z.enum(['true', 'false']).default(defaultValue).transform((value) => value === 'true');

const envSchema = z.object({
  SINDRAL_ENV: z.enum(['development', 'production']).default('development'),
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
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_INSTALLATIONS: optionalString,
  METRICS_TOKEN: optionalString,
  SINDRAL_JOB_DISPATCH_ENABLED: booleanString('true'),
  SINDRAL_AUTO_MERGE_ENABLED: booleanString('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_DIST_DIR: optionalString,
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface AppConfig {
  environment: 'development' | 'production';
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseJwtSecret: string | undefined;
  port: number;
  host: string;
  webOrigins: string[];
  secretsEncryptionKey: Buffer;
  githubWebhookSecret: string | undefined;
  githubAppId: string | undefined;
  githubAppPrivateKey: string | undefined;
  githubAppInstallations: Record<string, number>;
  metricsToken: string | undefined;
  jobDispatchEnabled: boolean;
  autoMergeEnabled: boolean;
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
  const webOrigins = parseWebOrigins(e.WEB_ORIGIN);
  if (e.SINDRAL_ENV === 'production') {
    if (new URL(e.SUPABASE_URL).protocol !== 'https:') throw new ConfigError('SUPABASE_URL must use HTTPS in production');
    if (webOrigins.some((origin) => new URL(origin).protocol !== 'https:')) throw new ConfigError('WEB_ORIGIN must use HTTPS in production');
    if (!e.GITHUB_WEBHOOK_SECRET || e.GITHUB_WEBHOOK_SECRET.length < 32) {
      throw new ConfigError('GITHUB_WEBHOOK_SECRET must contain at least 32 characters in production');
    }
    if (!e.METRICS_TOKEN || e.METRICS_TOKEN.length < 32) throw new ConfigError('METRICS_TOKEN must contain at least 32 characters in production');
  }
  const githubAppValues = [e.GITHUB_APP_ID, e.GITHUB_APP_PRIVATE_KEY, e.GITHUB_APP_INSTALLATIONS];
  if (githubAppValues.some((value) => value !== undefined) && githubAppValues.some((value) => value === undefined)) {
    throw new ConfigError('GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATIONS must be configured together');
  }
  let githubAppInstallations: Record<string, number> = {};
  if (e.GITHUB_APP_INSTALLATIONS) {
    try {
      githubAppInstallations = z.record(z.string().uuid(), z.number().int().positive()).parse(JSON.parse(e.GITHUB_APP_INSTALLATIONS));
    } catch {
      throw new ConfigError('GITHUB_APP_INSTALLATIONS must be a JSON object mapping Sindral user UUIDs to positive GitHub installation IDs');
    }
  }
  return {
    environment: e.SINDRAL_ENV,
    supabaseUrl: e.SUPABASE_URL,
    supabaseAnonKey: e.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    supabaseJwtSecret: e.SUPABASE_JWT_SECRET,
    port: e.PORT,
    host: e.HOST,
    webOrigins,
    secretsEncryptionKey: Buffer.from(e.SECRETS_ENCRYPTION_KEY, 'hex'),
    githubWebhookSecret: e.GITHUB_WEBHOOK_SECRET,
    githubAppId: e.GITHUB_APP_ID,
    githubAppPrivateKey: e.GITHUB_APP_PRIVATE_KEY?.replaceAll('\\n', '\n'),
    githubAppInstallations,
    metricsToken: e.METRICS_TOKEN,
    jobDispatchEnabled: e.SINDRAL_JOB_DISPATCH_ENABLED,
    autoMergeEnabled: e.SINDRAL_AUTO_MERGE_ENABLED,
    logLevel: e.LOG_LEVEL,
    webDistDir: e.WEB_DIST_DIR ?? path.resolve(SERVER_PACKAGE_DIR, '..', 'web', 'dist'),
  };
}

function parseWebOrigins(raw: string): string[] {
  const origins = raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) throw new ConfigError('WEB_ORIGIN must contain at least one origin');
  return origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError(`WEB_ORIGIN contains an invalid URL: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new ConfigError(`WEB_ORIGIN must contain exact HTTP(S) origins without paths, credentials, queries, or fragments: ${origin}`);
    }
    return parsed.origin;
  });
}

/** Load `.env` from the repo root and the cwd (existing process env wins), then validate. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  for (const dir of [REPO_ROOT, process.cwd()]) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
  }
  return parseConfig(env);
}
