import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngines } from './engines/index.js';
import { gitIn } from './git.js';
import { runJob } from './job.js';
import { silentLogger } from './logger.js';
import { agentPayload, dispatch, GH_TOKEN, testConfig } from './test/fixtures.js';
import { WorkspaceManager, type GitFactory } from './workspace.js';

describe('runJob with real process and git boundaries', () => {
  let root: string;
  let workdir: string;
  let remote: string;
  let claudeBin: string;
  let ghBin: string;
  let ghLog: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-job-integration-'));
    workdir = path.join(root, 'worker');
    remote = path.join(root, 'remote.git');
    claudeBin = path.join(root, 'fake-claude');
    ghBin = path.join(root, 'fake-gh');
    ghLog = path.join(root, 'gh-calls.jsonl');

    const seed = path.join(root, 'seed');
    await fs.mkdir(seed);
    await gitIn(root)(['init', '--bare', remote]);
    await gitIn(seed)(['init', '-b', 'main']);
    await fs.writeFile(path.join(seed, 'README.md'), 'base\n');
    await gitIn(seed)(['add', 'README.md']);
    await gitIn(seed)(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial']);
    await gitIn(seed)(['remote', 'add', 'origin', remote]);
    await gitIn(seed)(['push', '-u', 'origin', 'main']);
    await gitIn(root)(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

    await writeExecutable(
      claudeBin,
      `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('claude 1.2.3'); process.exit(0); }
if (args.includes('--help')) { console.log('--effort'); process.exit(0); }
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.SINDRAL_WORKER_KEY) {
  console.error('credential leaked to agent');
  process.exit(2);
}
fs.appendFileSync('README.md', 'implemented by fake agent\\n');
fs.writeFileSync(process.env.SINDRAL_RESULT_FILE, JSON.stringify({ summary: 'Implemented through the real worker boundary' }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'implementation complete' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify({ summary: 'Implemented through the real worker boundary' }) }));
`,
    );
    await writeExecutable(
      ghBin,
      `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args, cwd: process.cwd(), token: process.env.GH_TOKEN ?? null }) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') console.log('[]');
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/acme/widgets/pull/42');
else process.exitCode = 1;
`,
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prepares a worktree, runs an isolated agent, pushes a commit, and opens a PR', async () => {
    const localGit: GitFactory = (cwd, auth) => {
      const actual = gitIn(cwd, auth);
      const invoke = ((args, options) => actual(translateClone(args, remote), options)) as ReturnType<GitFactory>;
      invoke.try = (args, options) => actual.try(translateClone(args, remote), options);
      return invoke;
    };
    const config = testConfig({ workdir, claudeBin, ghBin });
    const api = {
      postEvent: vi.fn(async () => ({ ok: true as const })),
      complete: vi.fn(async () => ({ ok: true as const })),
      fail: vi.fn(async () => ({ ok: true as const })),
      cancel: vi.fn(async () => ({ ok: true as const })),
    };
    const basePayload = agentPayload();
    const jobDispatch = dispatch({ payload: { ...basePayload, context: { ...basePayload.context, task_key: 'E2E-1' } } });

    const outcome = await runJob(
      jobDispatch,
      {
        config,
        api,
        engines: createEngines(config),
        workspaces: new WorkspaceManager(workdir, { git: localGit }),
        logger: silentLogger(),
        git: localGit,
        env: { ...process.env, GH_TOKEN, SINDRAL_WORKER_KEY: config.workerKey },
        progressIntervalMs: 1_000_000,
      },
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      status: 'completed',
      result: {
        kind: 'pr',
        prUrl: 'https://github.com/acme/widgets/pull/42',
        branch: 'sindral/e2e-1',
        pullRequests: [{ repository: 'acme/widgets', number: 42, branch: 'sindral/e2e-1', baseBranch: 'main' }],
      },
    });
    expect(api.complete).toHaveBeenCalledOnce();
    expect(api.fail).not.toHaveBeenCalled();

    const remoteReadme = await gitIn(root)(['--git-dir', remote, 'show', 'refs/heads/sindral/e2e-1:README.md']);
    expect(remoteReadme.stdout).toContain('implemented by fake agent');
    const calls = (await fs.readFile(ghLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; token: string | null });
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'list'],
      ['pr', 'create'],
    ]);
    expect(calls.every((call) => call.token === GH_TOKEN)).toBe(true);
  });
});

async function writeExecutable(file: string, source: string): Promise<void> {
  await fs.writeFile(file, source, { mode: 0o700 });
}

function translateClone(args: readonly string[], remote: string): string[] {
  if (args[0] !== 'clone') return [...args];
  const option = args[1];
  const destination = args[3];
  if (!option || !destination) throw new Error('unexpected clone arguments');
  return ['clone', option, remote, destination];
}
