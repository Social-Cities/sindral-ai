import { runOrThrow, run, type RunOptions, type RunResult } from './proc.js';

export interface GitAuth {
  /** Extra `git -c` arguments carrying the auth header; empty without a token. */
  configArgs: string[];
  /** The header value, registered with the redactor so it never leaks. */
  secrets: string[];
}

/**
 * GitHub authentication for clone/fetch/push without ever writing the token
 * into `.git/config` or a remote URL: the token is passed as a per-invocation
 * `http.extraheader` config value.
 */
export function gitAuth(token: string | null | undefined): GitAuth {
  if (!token) return { configArgs: [], secrets: [] };
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    configArgs: ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`],
    secrets: [token, basic],
  };
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' } as const;

export interface GitRunner {
  (args: readonly string[], opts?: RunOptions): Promise<RunResult>;
  /** Same as the runner, but never throws. */
  try(args: readonly string[], opts?: RunOptions): Promise<RunResult>;
}

/** Builds a git invoker bound to a directory and (optionally) auth config. */
export function gitIn(cwd: string, auth: GitAuth = gitAuth(null)): GitRunner {
  const runner = ((args, opts = {}) =>
    runOrThrow('git', [...auth.configArgs, ...args], { ...opts, cwd, env: { ...GIT_ENV, ...opts.env } })) as GitRunner;
  runner.try = (args, opts = {}) => run('git', [...auth.configArgs, ...args], { ...opts, cwd, env: { ...GIT_ENV, ...opts.env } });
  return runner;
}

const REF_FORBIDDEN = /[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|\.lock$|^@$/;

/** Mirrors the rules of `git check-ref-format --branch` closely enough to reject anything dangerous. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (REF_FORBIDDEN.test(name)) return false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.'));
}

export function assertBranchName(name: string): string {
  if (!isValidBranchName(name)) throw new Error(`Invalid git branch name: ${JSON.stringify(name)}`);
  return name;
}
