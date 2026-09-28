import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Writable as WritableStream } from 'node:stream';
import { createInterface, type Interface } from 'node:readline/promises';
import { expandHome, loadConfig, userConfigFile } from './config.js';
import { run, runInteractive, type RunOptions, type RunResult } from './proc.js';

export interface ConfigurePrompter {
  question(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
}

export class TerminalPrompter implements ConfigurePrompter {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly readlineOutput: Writable;
  private readonly rl: Interface;
  private muted = false;

  constructor(input: Readable = process.stdin, output: Writable = process.stdout) {
    this.input = input;
    this.output = output;
    this.readlineOutput = new WritableStream({
      write: (chunk, encoding, callback) => {
        if (!this.muted) this.output.write(chunk, encoding);
        callback();
      },
    });
    this.rl = createInterface({
      input: this.input,
      output: this.readlineOutput,
      terminal: Boolean((this.input as NodeJS.ReadStream).isTTY && (this.output as NodeJS.WriteStream).isTTY),
    });
  }

  async question(label: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await this.rl.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue || '';
  }

  async secret(label: string): Promise<string> {
    if (!(this.input as NodeJS.ReadStream).isTTY || !(this.output as NodeJS.WriteStream).isTTY) throw new Error('Secret input requires an interactive terminal');
    this.output.write(`${label}: `);
    this.muted = true;
    try {
      return (await this.rl.question('')).trim();
    } finally {
      this.muted = false;
      this.output.write('\n');
    }
  }

  close(): void {
    this.rl.close();
  }
}

export interface ConfigureCommands {
  run(file: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
  interactive(file: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
}

export interface ConfigureOptions {
  prompter: ConfigurePrompter;
  commands?: ConfigureCommands;
  env?: NodeJS.ProcessEnv;
  write?: (message: string) => void;
  home?: string;
  hostname?: string;
}

const defaultCommands: ConfigureCommands = { run, interactive: runInteractive };

function succeeded(result: RunResult): boolean {
  return !result.failed && result.exitCode === 0;
}

async function ensureAuthentication(options: {
  name: 'Claude' | 'Codex';
  bin: string;
  statusArgs: string[];
  loginArgs: string[];
  env: Record<string, string | undefined>;
  commands: ConfigureCommands;
  write: (message: string) => void;
}): Promise<boolean> {
  const probe = await options.commands.run(options.bin, ['--version'], { env: options.env, timeoutMs: 15_000 });
  if (!succeeded(probe)) {
    if (probe.code === 'ENOENT') {
      options.write(`${options.name} CLI not found; skipping authentication.\n`);
      return false;
    }
    throw new Error(`${options.name} CLI check failed`);
  }
  const before = await options.commands.run(options.bin, options.statusArgs, { env: options.env, timeoutMs: 15_000 });
  if (succeeded(before)) {
    options.write(`${options.name} is already authenticated.\n`);
    return true;
  }
  options.write(`Starting ${options.name} authentication…\n`);
  const login = await options.commands.interactive(options.bin, options.loginArgs, { env: options.env });
  if (!succeeded(login)) throw new Error(`${options.name} authentication failed`);
  const after = await options.commands.run(options.bin, options.statusArgs, { env: options.env, timeoutMs: 15_000 });
  if (!succeeded(after)) throw new Error(`${options.name} authentication could not be verified`);
  options.write(`${options.name} authentication verified.\n`);
  return true;
}

async function writeConfigFile(file: string, values: Record<string, string>): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function ensurePrivateDirectory(directory: string, label: string, home: string): Promise<void> {
  const lexicalHome = path.resolve(home);
  const requested = path.resolve(directory);
  const relative = path.relative(lexicalHome, requested);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a dedicated subdirectory inside ${lexicalHome}`);
  }

  let current = await fs.realpath(lexicalHome);
  let createdFinal = false;
  const parts = relative.split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
      if (index === parts.length - 1) createdFinal = true;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} path cannot contain links or non-directories: ${current}`);
  }

  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const directoryHandle = await fs.open(current, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollow);
  try {
    const stat = await directoryHandle.stat();
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user: ${requested}`);
    if (createdFinal) await directoryHandle.chmod(0o700);
    else if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
      throw new Error(`${label} must have mode 0700 before configuration: ${requested}`);
    }
  } finally {
    await directoryHandle.close();
  }
}

/** Runs the one-time local worker setup without sending provider credentials to Sindral. */
export async function configureWorker(initial: Record<string, string | undefined>, options: ConfigureOptions): Promise<void> {
  const commands = options.commands ?? defaultCommands;
  const write = options.write ?? ((message: string) => process.stdout.write(message));
  const home = options.home ?? os.homedir();
  const hostname = options.hostname ?? os.hostname();
  const defaultWorkdir = initial['SINDRAL_WORKDIR']?.trim() || '~/.sindral';
  const workdirInput = await options.prompter.question('Worker directory', defaultWorkdir);
  const workdir = path.resolve(expandHome(workdirInput, home));
  const serverUrl = await options.prompter.question('Sindral server URL', initial['SINDRAL_SERVER_URL']?.trim());
  const existingKey = initial['SINDRAL_WORKER_KEY']?.trim() || '';
  const enteredKey = await options.prompter.secret(existingKey ? 'Worker key (press Enter to keep the configured key)' : 'Worker key');
  const workerKey = enteredKey || existingKey;
  const workerName = await options.prompter.question('Worker name', initial['SINDRAL_WORKER_NAME']?.trim() || hostname);
  const codexHome = path.resolve(expandHome(initial['SINDRAL_CODEX_HOME']?.trim() || path.join(workdir, 'tool-state', 'codex'), home));

  const values: Record<string, string> = {
    SINDRAL_SERVER_URL: serverUrl,
    SINDRAL_WORKER_KEY: workerKey,
    SINDRAL_WORKDIR: workdir,
    SINDRAL_WORKER_NAME: workerName,
    SINDRAL_CODEX_HOME: codexHome,
  };
  for (const key of ['SINDRAL_CONCURRENCY', 'SINDRAL_CLAUDE_BIN', 'SINDRAL_CODEX_BIN', 'SINDRAL_GH_BIN', 'SINDRAL_JOB_TIMEOUT_MINUTES', 'SINDRAL_RETENTION_DAYS', 'SINDRAL_ALLOW_PAT_MERGE', 'LOG_LEVEL']) {
    const value = initial[key]?.trim();
    if (value) values[key] = value;
  }
  const config = loadConfig(values, { home, hostname });

  const configFile = userConfigFile(home);
  await ensurePrivateDirectory(config.workdir, 'Worker directory', home);
  await ensurePrivateDirectory(codexHome, 'Codex state directory', home);
  await ensurePrivateDirectory(path.dirname(configFile), 'Sindral config directory', home);

  const baseEnv = { ...(options.env ?? process.env) };
  await ensureAuthentication({
    name: 'Claude',
    bin: config.claudeBin,
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    env: baseEnv,
    commands,
    write,
  });
  await ensureAuthentication({
    name: 'Codex',
    bin: config.codexBin,
    statusArgs: ['login', 'status'],
    loginArgs: ['login', '--device-auth'],
    env: { ...baseEnv, CODEX_HOME: codexHome },
    commands,
    write,
  });

  await writeConfigFile(configFile, values);
  write(`Worker configured at ${configFile}.\n`);
}
