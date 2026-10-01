#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ApiClient, WorkerAuthError, WorkerProtocolError } from './api.js';
import { ConfigError, expandHome, loadConfig, workdirPaths, type WorkerConfig } from './config.js';
import { createEngines, describeVersion } from './engines/index.js';
import { runJob } from './job.js';
import { createLogger, type Logger } from './logger.js';
import { errorMessage } from './redact.js';
import { Runner, type RunnerPersistence, type RunningJob } from './runner.js';
import { WORKER_VERSION } from './version.js';
import { WorkspaceManager } from './workspace.js';

const CONFIG_KEYS = [
  'SINDRAL_SERVER_URL',
  'SINDRAL_WORKER_KEY',
  'SINDRAL_WORKDIR',
  'SINDRAL_CONCURRENCY',
  'SINDRAL_WORKER_NAME',
  'SINDRAL_CLAUDE_BIN',
  'SINDRAL_CODEX_BIN',
  'SINDRAL_GH_BIN',
  'SINDRAL_EXTRA_PATH',
  'SINDRAL_JOB_TIMEOUT_MINUTES',
  'SINDRAL_RETENTION_DAYS',
  'SINDRAL_ALLOW_PAT_MERGE',
  'LOG_LEVEL',
] as const;

const USAGE = `sindral-worker ${WORKER_VERSION}

Usage:
  sindral-worker [start]   Run the worker daemon (default)
  sindral-worker clean [--dry-run]
                           Remove inactive retained workspaces and job artifacts
  sindral-worker --version
  sindral-worker --help

Configuration comes from environment variables (SINDRAL_*), a .env file in the
current directory or the repository root, or <workdir>/config.json. Environment
variables take precedence.`;

export function applyExtraPath(extraPath: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!extraPath) return;
  const current = env['PATH'] ?? '';
  env['PATH'] = current ? `${extraPath}${path.delimiter}${current}` : extraPath;
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (dir === path.dirname(dir)) return null;
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** Loads .env files and `<workdir>/config.json`, with the process environment winning. */
export async function loadEnvironment(): Promise<Record<string, string | undefined>> {
  const cwd = process.cwd();
  const candidates = [path.join(cwd, '.env')];
  const roots = [findRepoRoot(cwd), findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))].filter((r): r is string => Boolean(r));
  for (const root of roots) {
    const file = path.join(root, '.env');
    if (!candidates.includes(file)) candidates.push(file);
  }
  dotenv.config({ path: candidates.filter((f) => existsSync(f)), quiet: true });

  const merged: Record<string, string | undefined> = {};
  const workdir = path.resolve(expandHome(process.env['SINDRAL_WORKDIR']?.trim() || '~/.sindral'));
  try {
    const raw = await fs.readFile(workdirPaths(workdir).configFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of CONFIG_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' || typeof value === 'number') merged[key] = String(value);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`warning: could not read ${workdirPaths(workdir).configFile}: ${errorMessage(err)}\n`);
    }
  }
  for (const key of CONFIG_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== '') merged[key] = value;
  }
  return merged;
}

function filePersistence(config: WorkerConfig): RunnerPersistence {
  const paths = workdirPaths(config.workdir);
  return {
    async loadWorkerId() {
      try {
        const parsed = JSON.parse(await fs.readFile(paths.workerFile, 'utf8')) as { workerId?: unknown };
        return typeof parsed.workerId === 'string' ? parsed.workerId : null;
      } catch {
        return null;
      }
    },
    async saveWorkerId(workerId) {
      await fs.mkdir(config.workdir, { recursive: true });
      await fs.writeFile(paths.workerFile, JSON.stringify({ workerId, serverUrl: config.serverUrl, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    },
    async saveRunning(jobs: RunningJob[]) {
      await fs.mkdir(config.workdir, { recursive: true });
      await fs.writeFile(paths.runningFile, JSON.stringify({ updatedAt: new Date().toISOString(), jobs }, null, 2));
    },
  };
}

async function start(config: WorkerConfig, logger: Logger): Promise<number> {
  await fs.mkdir(config.workdir, { recursive: true, mode: 0o700 });
  const engines = createEngines(config);
  const version = await describeVersion(WORKER_VERSION, engines);
  logger.info({ version, workdir: config.workdir, server: config.serverUrl }, 'starting sindral worker');
  for (const name of ['claude', 'codex'] as const) {
    const caps = await engines[name].probe();
    if (!caps.available) logger.warn({ engine: name }, 'engine binary not found; steps using it will fail');
  }

  const api = new ApiClient({ baseUrl: config.serverUrl, workerKey: config.workerKey, logger });
  const workspaces = new WorkspaceManager(config.workdir, { logger });
  const runner = new Runner({
    config,
    api,
    logger,
    version,
    hostname: os.hostname(),
    persistence: filePersistence(config),
    runJob: (dispatch, signal) => runJob(dispatch, { config, api, engines, workspaces, logger }, signal),
  });

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      logger.warn('second signal received; exiting immediately');
      process.exit(130);
    }
    signalled = true;
    logger.info({ signal }, 'shutting down; waiting for running jobs');
    void runner.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await runner.start();
    return 0;
  } catch (err) {
    if (err instanceof WorkerAuthError || err instanceof WorkerProtocolError) {
      logger.fatal(err.message);
      return 2;
    }
    logger.fatal({ err: errorMessage(err) }, 'worker crashed');
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function clean(config: WorkerConfig, logger: Logger, dryRun: boolean): Promise<number> {
  const workerId = await filePersistence(config).loadWorkerId();
  if (!workerId) throw new Error('Cannot verify active leases: start this worker once before running cleanup');
  const api = new ApiClient({ baseUrl: config.serverUrl, workerKey: config.workerKey, logger });
  const status = await api.cleanupStatus({ workerId });
  if (status.workerOnline || status.activeJobs.length > 0) {
    const detail = status.workerOnline ? 'worker is online' : `${status.activeJobs.length} active job lease(s)`;
    process.stderr.write(`cleanup refused: ${detail}; stop the worker and wait for active leases to finish or expire\n`);
    return 2;
  }
  const workspaces = new WorkspaceManager(config.workdir, { logger });
  const report = await workspaces.clean({
    activeTaskKeys: new Set(status.activeJobs.map((job) => job.taskKey)),
    activeJobIds: new Set(status.activeJobs.map((job) => job.jobId)),
    olderThan: new Date(Date.now() - config.retentionMs),
    dryRun,
  });
  const paths = dryRun ? report.wouldRemove : report.removed;
  for (const candidate of paths) process.stdout.write(`${dryRun ? 'would remove' : 'removed'} ${candidate}\n`);
  process.stdout.write(
    `${paths.length} path(s) ${dryRun ? 'eligible' : 'removed'}; ${report.keptRecent.length} recent path(s) kept; retention ${Math.round(config.retentionMs / 86_400_000)} day(s)\n`,
  );
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? 'start';
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${WORKER_VERSION}\n`);
    return 0;
  }
  if (command !== 'start' && command !== 'clean') {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
    return 1;
  }
  const commandArgs = argv.slice(1);
  if (commandArgs.some((arg) => arg !== '--dry-run') || (command === 'start' && commandArgs.length > 0)) {
    process.stderr.write(`Invalid arguments for ${command}\n\n${USAGE}\n`);
    return 1;
  }

  let config: WorkerConfig;
  try {
    config = loadConfig(await loadEnvironment());
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  applyExtraPath(config.extraPath);
  const logger = createLogger(config.logLevel);
  return command === 'clean' ? clean(config, logger, commandArgs.includes('--dry-run')) : start(config, logger);
}

// macOS temp and package-manager paths may enter through `/var` while the module URL
// resolves to `/private/var`; compare canonical paths so packaged CLIs still execute.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`fatal: ${errorMessage(err)}\n`);
      process.exitCode = 1;
    });
}
