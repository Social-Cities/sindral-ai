import { execa } from 'execa';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** When false, `env` fully replaces the inherited environment. */
  extendEnv?: boolean;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Node error code such as ENOENT when the binary could not be spawned. */
  code: string | null;
  message: string;
}

export interface StreamOptions extends RunOptions {
  onLine: (line: string) => void;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(asString).join('\n');
  return '';
}

function normalise(result: Record<string, unknown>): RunResult {
  const exitCode = typeof result['exitCode'] === 'number' ? result['exitCode'] : null;
  return {
    exitCode,
    stdout: asString(result['stdout']),
    stderr: asString(result['stderr']),
    failed: Boolean(result['failed']),
    timedOut: Boolean(result['timedOut']),
    cancelled: Boolean(result['isCanceled']),
    code: typeof result['code'] === 'string' ? result['code'] : null,
    message: typeof result['shortMessage'] === 'string' ? result['shortMessage'] : asString(result['message']),
  };
}

function fromThrown(err: unknown): RunResult {
  if (err && typeof err === 'object') {
    // Error.message is not enumerable, so copy it explicitly.
    const message = err instanceof Error ? err.message : undefined;
    return normalise({ message, ...(err as Record<string, unknown>), failed: true });
  }
  return { exitCode: null, stdout: '', stderr: '', failed: true, timedOut: false, cancelled: false, code: null, message: String(err) };
}

/**
 * Runs a command to completion and never throws; the caller inspects the
 * result. Always argv arrays, never a shell.
 */
export async function run(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    const result = await execa(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      extendEnv: opts.extendEnv ?? true,
      input: opts.input,
      timeout: opts.timeoutMs,
      cancelSignal: opts.signal,
      reject: false,
      stdin: opts.input === undefined ? 'ignore' : 'pipe',
      stripFinalNewline: true,
    });
    return normalise(result as unknown as Record<string, unknown>);
  } catch (err) {
    return fromThrown(err);
  }
}

export class CommandError extends Error {
  override name = 'CommandError';
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
  }
}

/** Like `run`, but throws a `CommandError` when the command fails. */
export async function runOrThrow(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await run(file, args, opts);
  if (result.failed || (result.exitCode !== null && result.exitCode !== 0)) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.message;
    throw new CommandError(`${file} ${args.join(' ')} failed (exit ${result.exitCode ?? result.code ?? '?'}): ${detail}`, result);
  }
  return result;
}

/** Runs an interactive command attached to the current terminal. */
export async function runInteractive(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    const result = await execa(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      extendEnv: opts.extendEnv ?? true,
      timeout: opts.timeoutMs,
      cancelSignal: opts.signal,
      reject: false,
      stdio: 'inherit',
    });
    return normalise(result as unknown as Record<string, unknown>);
  } catch (err) {
    return fromThrown(err);
  }
}

/**
 * Runs a long-lived command, forwarding stdout/stderr line by line while the
 * process runs. Used for agent CLIs so their output can be streamed to the
 * server as it happens.
 */
export async function stream(file: string, args: readonly string[], opts: StreamOptions): Promise<RunResult> {
  try {
    const subprocess = execa(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      extendEnv: opts.extendEnv ?? true,
      input: opts.input,
      timeout: opts.timeoutMs,
      cancelSignal: opts.signal,
      reject: false,
      all: true,
      buffer: false,
      stdin: opts.input === undefined ? 'ignore' : 'pipe',
    });
    const reading = (async () => {
      try {
        for await (const line of subprocess.iterable({ from: 'all' })) opts.onLine(line);
      } catch {
        // stream errors surface through the subprocess result below
      }
    })();
    const result = await subprocess;
    await reading;
    return normalise(result as unknown as Record<string, unknown>);
  } catch (err) {
    return fromThrown(err);
  }
}
