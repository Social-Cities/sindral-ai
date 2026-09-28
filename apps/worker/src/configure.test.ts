import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureWorker, type ConfigureCommands, type ConfigurePrompter } from './configure.js';
import type { RunOptions, RunResult } from './proc.js';
import { WORKER_KEY } from './test/fixtures.js';

const ok = (): RunResult => ({ exitCode: 0, stdout: '', stderr: '', failed: false, timedOut: false, cancelled: false, code: null, message: '' });
const failed = (message = 'ERR', code: string | null = null): RunResult => ({
  exitCode: code === 'ENOENT' ? null : 1,
  stdout: '',
  stderr: message,
  failed: true,
  timedOut: false,
  cancelled: false,
  code,
  message,
});

class FakePrompter implements ConfigurePrompter {
  constructor(
    private readonly answers: string[],
    private readonly secretAnswer = WORKER_KEY,
  ) {}

  async question(): Promise<string> {
    return this.answers.shift() ?? '';
  }

  async secret(): Promise<string> {
    return this.secretAnswer;
  }
}

interface CommandCall {
  file: string;
  args: string[];
  env: Record<string, string | undefined> | undefined;
  interactive: boolean;
}

function fakeCommands(options: { authenticated?: boolean; missing?: string[]; failLogin?: string; failProbe?: string } = {}) {
  const authenticated = new Map([
    ['claude', Boolean(options.authenticated)],
    ['codex', Boolean(options.authenticated)],
  ]);
  const calls: CommandCall[] = [];
  const invoke = async (interactive: boolean, file: string, args: readonly string[], runOptions?: RunOptions): Promise<RunResult> => {
    calls.push({ file, args: [...args], env: runOptions?.env, interactive });
    if (options.missing?.includes(file)) return failed('not found', 'ENOENT');
    if (options.failProbe === file && args[0] === '--version') return failed('crashed');
    if (args[0] === '--version') return ok();
    const isStatus = (file === 'claude' && args.join(' ') === 'auth status') || (file === 'codex' && args.join(' ') === 'login status');
    if (isStatus) return authenticated.get(file) ? ok() : failed('not logged in');
    if (interactive) {
      if (options.failLogin === file) return failed('login failed');
      authenticated.set(file, true);
      return ok();
    }
    return ok();
  };
  const commands: ConfigureCommands = {
    run: (file, args, runOptions) => invoke(false, file, args, runOptions),
    interactive: (file, args, runOptions) => invoke(true, file, args, runOptions),
  };
  return { calls, commands };
}

describe('configureWorker', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-configure-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('authenticates installed CLIs, verifies them, and writes private worker config', async () => {
    const workdir = path.join(root, 'worker');
    const { calls, commands } = fakeCommands();
    const output: string[] = [];
    await configureWorker({}, {
      prompter: new FakePrompter([workdir, 'https://sindral.example.com/', 'worker-one']),
      commands,
      env: { PATH: '/bin' },
      home: root,
      hostname: 'host',
      write: (message) => output.push(message),
    });

    const configFile = path.join(root, '.sindral', 'config.json');
    const saved = JSON.parse(await fs.readFile(configFile, 'utf8')) as Record<string, string>;
    expect(saved).toMatchObject({
      SINDRAL_SERVER_URL: 'https://sindral.example.com/',
      SINDRAL_WORKER_KEY: WORKER_KEY,
      SINDRAL_WORKDIR: workdir,
      SINDRAL_WORKER_NAME: 'worker-one',
      SINDRAL_CODEX_HOME: path.join(workdir, 'tool-state', 'codex'),
    });
    expect(JSON.stringify(saved)).not.toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(saved)).not.toContain('CODEX_API_KEY');
    expect((await fs.stat(workdir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(saved['SINDRAL_CODEX_HOME']!)).mode & 0o777).toBe(0o700);

    expect(calls.filter((call) => call.file === 'claude').map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'status'],
      ['auth', 'login'],
      ['auth', 'status'],
    ]);
    expect(calls.filter((call) => call.file === 'codex').map((call) => call.args)).toEqual([
      ['--version'],
      ['login', 'status'],
      ['login', '--device-auth'],
      ['login', 'status'],
    ]);
    expect(calls.filter((call) => call.file === 'codex').every((call) => call.env?.['CODEX_HOME'] === saved['SINDRAL_CODEX_HOME'])).toBe(true);
    expect(output.join('')).not.toContain(WORKER_KEY);
  });

  it('does not relaunch authentication when both CLIs are already authenticated', async () => {
    const workdir = path.join(root, 'worker');
    const { calls, commands } = fakeCommands({ authenticated: true });
    await configureWorker({}, {
      prompter: new FakePrompter([workdir, 'http://localhost:8787', 'worker']),
      commands,
      home: root,
      write: () => undefined,
    });
    expect(calls.some((call) => call.interactive)).toBe(false);
  });

  it('tolerates missing engines and still saves a usable worker configuration', async () => {
    const workdir = path.join(root, 'worker');
    const { calls, commands } = fakeCommands({ missing: ['claude', 'codex'] });
    const output: string[] = [];
    await configureWorker({}, {
      prompter: new FakePrompter([workdir, 'http://localhost:8787', 'worker']),
      commands,
      home: root,
      write: (message) => output.push(message),
    });
    expect(calls).toHaveLength(2);
    expect(output.join('')).toContain('Claude CLI not found');
    expect(output.join('')).toContain('Codex CLI not found');
    await expect(fs.readFile(path.join(root, '.sindral', 'config.json'), 'utf8')).resolves.toContain('SINDRAL_SERVER_URL');
  });

  it('fails when an installed engine cannot be probed', async () => {
    const workdir = path.join(root, 'worker');
    const { commands } = fakeCommands({ failProbe: 'claude' });
    await expect(
      configureWorker({}, {
        prompter: new FakePrompter([workdir, 'http://localhost:8787', 'worker']),
        commands,
        home: root,
        write: () => undefined,
      }),
    ).rejects.toThrow(/Claude CLI check failed/);
  });

  it('rejects broad or non-private existing directories without changing their permissions', async () => {
    const { commands } = fakeCommands({ missing: ['claude', 'codex'] });
    await expect(
      configureWorker({}, {
        prompter: new FakePrompter([root, 'http://localhost:8787', 'worker']),
        commands,
        home: root,
        write: () => undefined,
      }),
    ).rejects.toThrow(/dedicated subdirectory/);

    const shared = path.join(root, 'shared-worker');
    await fs.mkdir(shared, { mode: 0o755 });
    await fs.chmod(shared, 0o755);
    await expect(
      configureWorker({}, {
        prompter: new FakePrompter([shared, 'http://localhost:8787', 'worker']),
        commands,
        home: root,
        write: () => undefined,
      }),
    ).rejects.toThrow(/mode 0700/);
    expect((await fs.stat(shared)).mode & 0o777).toBe(0o755);
  });

  it('rejects a symlink in a missing directory path without creating through it', async () => {
    const target = path.join(root, 'target');
    const linkedParent = path.join(root, 'linked-parent');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, linkedParent);
    const { commands } = fakeCommands({ missing: ['claude', 'codex'] });

    await expect(
      configureWorker({}, {
        prompter: new FakePrompter([path.join(linkedParent, 'worker'), 'http://localhost:8787', 'worker']),
        commands,
        home: root,
        write: () => undefined,
      }),
    ).rejects.toThrow(/cannot contain links/);
    await expect(fs.stat(path.join(target, 'worker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite an existing config when validation or authentication fails', async () => {
    const workdir = path.join(root, 'worker');
    await fs.mkdir(workdir, { recursive: true, mode: 0o700 });
    await fs.chmod(workdir, 0o700);
    const configFile = path.join(root, '.sindral', 'config.json');
    await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(configFile), 0o700);
    await fs.writeFile(configFile, '{"preserved":true}\n');
    const { commands } = fakeCommands({ failLogin: 'claude' });

    await expect(
      configureWorker({}, {
        prompter: new FakePrompter([workdir, 'http://localhost:8787', 'worker']),
        commands,
        home: root,
        write: () => undefined,
      }),
    ).rejects.toThrow(/Claude authentication failed/);
    await expect(fs.readFile(configFile, 'utf8')).resolves.toBe('{"preserved":true}\n');

    await expect(
      configureWorker({}, {
        prompter: new FakePrompter([workdir, 'not-a-url', 'worker']),
        commands,
        home: root,
        write: () => undefined,
      }),
    ).rejects.toThrow(/SINDRAL_SERVER_URL/);
    await expect(fs.readFile(configFile, 'utf8')).resolves.toBe('{"preserved":true}\n');
  });

  it('keeps an existing worker key when secret input is empty', async () => {
    const workdir = path.join(root, 'worker');
    const { commands } = fakeCommands({ missing: ['claude', 'codex'] });
    await configureWorker({ SINDRAL_WORKER_KEY: WORKER_KEY }, {
      prompter: new FakePrompter([workdir, 'http://localhost:8787', 'worker'], ''),
      commands,
      home: root,
      write: () => undefined,
    });
    const saved = JSON.parse(await fs.readFile(path.join(root, '.sindral', 'config.json'), 'utf8')) as Record<string, string>;
    expect(saved['SINDRAL_WORKER_KEY']).toBe(WORKER_KEY);
  });
});
