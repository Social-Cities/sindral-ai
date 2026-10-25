import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const WORKER_KEY_RE = /^sk_sindral_[0-9a-f]{40}$/;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const PUBLISH_CHECK_MODES = ['off', 'advisory', 'strict'] as const;

const configSchema = z.object({
  SINDRAL_SERVER_URL: z
    .string()
    .trim()
    .url()
    .transform((url) => url.replace(/\/+$/, '')),
  SINDRAL_WORKER_KEY: z.string().trim().regex(WORKER_KEY_RE, 'SINDRAL_WORKER_KEY must look like sk_sindral_<40 hex chars>'),
  SINDRAL_WORKDIR: z.string().trim().min(1).default('~/.sindral'),
  SINDRAL_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  SINDRAL_WORKER_NAME: z.string().trim().max(200).optional(),
  SINDRAL_CLAUDE_BIN: z.string().trim().min(1).default('claude'),
  SINDRAL_CODEX_BIN: z.string().trim().min(1).default('codex'),
  SINDRAL_GH_BIN: z.string().trim().min(1).default('gh'),
  SINDRAL_EXTRA_PATH: z.string().trim().optional(),
  SINDRAL_JOB_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(90),
  SINDRAL_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  SINDRAL_ALLOW_PAT_MERGE: z.enum(['true', 'false']).default('false'),
  SINDRAL_PUBLISH_CHECKS: z.string().trim().optional(),
  SINDRAL_PUBLISH_CHECK_MODE: z.enum(PUBLISH_CHECK_MODES).default('off'),
  SINDRAL_PUBLISH_CHECK_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export interface PublishCheck {
  command: string;
  args: string[];
}

export interface WorkerConfig {
  serverUrl: string;
  workerKey: string;
  workdir: string;
  concurrency: number;
  workerName: string;
  claudeBin: string;
  codexBin: string;
  ghBin: string;
  extraPath?: string;
  jobTimeoutMs: number;
  retentionMs: number;
  allowPatMerge: boolean;
  publishChecks: PublishCheck[];
  publishCheckMode: (typeof PUBLISH_CHECK_MODES)[number];
  publishCheckTimeoutMs: number;
  logLevel: (typeof LOG_LEVELS)[number];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** Stable config location used to discover a worker whose data directory is elsewhere. */
export function userConfigFile(home: string = os.homedir()): string {
  return path.join(home, '.sindral', 'config.json');
}

/** Empty strings (e.g. `SINDRAL_WORKER_NAME=` in .env.example) count as unset. */
function dropEmpty(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
  opts: { home?: string; hostname?: string } = {},
): WorkerConfig {
  const parsed = configSchema.safeParse(dropEmpty(source));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid worker configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const workdir = path.resolve(expandHome(c.SINDRAL_WORKDIR, opts.home));
  return {
    serverUrl: c.SINDRAL_SERVER_URL,
    workerKey: c.SINDRAL_WORKER_KEY,
    workdir,
    concurrency: c.SINDRAL_CONCURRENCY,
    workerName: c.SINDRAL_WORKER_NAME ?? opts.hostname ?? os.hostname(),
    claudeBin: c.SINDRAL_CLAUDE_BIN,
    codexBin: c.SINDRAL_CODEX_BIN,
    ghBin: c.SINDRAL_GH_BIN,
    extraPath: c.SINDRAL_EXTRA_PATH,
    jobTimeoutMs: c.SINDRAL_JOB_TIMEOUT_MINUTES * 60_000,
    retentionMs: c.SINDRAL_RETENTION_DAYS * 24 * 60 * 60_000,
    allowPatMerge: c.SINDRAL_ALLOW_PAT_MERGE === 'true',
    publishChecks: parsePublishChecks(c.SINDRAL_PUBLISH_CHECKS ?? ''),
    publishCheckMode: c.SINDRAL_PUBLISH_CHECK_MODE,
    publishCheckTimeoutMs: c.SINDRAL_PUBLISH_CHECK_TIMEOUT_MINUTES * 60_000,
    logLevel: c.LOG_LEVEL,
  };
}

export function parsePublishChecks(value: string): PublishCheck[] {
  return value
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = splitCommandLine(line);
      if (parts.length === 0) throw new ConfigError(`Invalid empty publish check: ${JSON.stringify(line)}`);
      const [command, ...args] = parts;
      if (!command) throw new ConfigError(`Invalid publish check: ${JSON.stringify(line)}`);
      return { command, args };
    });
}

function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (quote) throw new ConfigError(`Unclosed quote in publish check: ${line}`);
  if (current) parts.push(current);
  return parts;
}

/** Well-known sub-directories of the workdir. */
export function workdirPaths(workdir: string) {
  return {
    repos: path.join(workdir, 'repos'),
    worktrees: path.join(workdir, 'worktrees'),
    tmp: path.join(workdir, 'tmp'),
    results: path.join(workdir, 'results'),
    outputs: path.join(workdir, 'outputs'),
    designs: path.join(workdir, 'design'),
    designInputs: path.join(workdir, 'design-inputs'),
    logs: path.join(workdir, 'logs'),
    workerFile: path.join(workdir, 'worker.json'),
    runningFile: path.join(workdir, 'running.json'),
    configFile: path.join(workdir, 'config.json'),
  };
}
