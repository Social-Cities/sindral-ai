import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIn } from './git.js';
import { WorkspaceManager, type GitFactory } from './workspace.js';

describe('WorkspaceManager with real git', () => {
  let root: string;
  let workdir: string;
  let remote: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-real-git-'));
    workdir = path.join(root, 'worker');
    remote = path.join(root, 'remote.git');
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
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reuses one clone while isolating task worktrees, resumes pushed branches, and cleans only inactive work', async () => {
    const localGit: GitFactory = (cwd, auth) => {
      const actual = gitIn(cwd, auth);
      const invoke = ((args, options) => {
        return actual(translateClone(args, remote), options);
      }) as ReturnType<GitFactory>;
      invoke.try = (args, options) => {
        return actual.try(translateClone(args, remote), options);
      };
      return invoke;
    };
    const manager = new WorkspaceManager(workdir, { git: localGit });
    const first = await manager.prepare({ taskKey: 'ENG-1', repos: ['acme/widgets'], branch: null, baseBranch: null, githubToken: null });
    const second = await manager.prepare({ taskKey: 'ENG-2', repos: ['acme/widgets'], branch: null, baseBranch: null, githubToken: null });

    expect(first.repos[0]?.repoDir).toBe(second.repos[0]?.repoDir);
    expect(first.cwd).not.toBe(second.cwd);
    await fs.writeFile(path.join(first.cwd, 'README.md'), 'task one\n');
    expect(await fs.readFile(path.join(second.cwd, 'README.md'), 'utf8')).toBe('base\n');

    const firstGit = gitIn(first.cwd);
    await firstGit(['add', 'README.md']);
    await firstGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'task one']);
    await firstGit(['push', '-u', 'origin', 'sindral/eng-1']);
    const resumed = await manager.prepare({ taskKey: 'ENG-1', repos: ['acme/widgets'], branch: null, baseBranch: null, githubToken: null });
    expect(resumed.repos[0]?.resumed).toBe(true);

    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    await fs.utimes(path.dirname(first.cwd), old, old);
    await fs.utimes(path.dirname(second.cwd), old, old);
    const canonicalFirst = await fs.realpath(first.cwd);
    const canonicalSecond = await fs.realpath(second.cwd);
    const report = await manager.clean({
      activeTaskKeys: new Set(['ENG-2']),
      activeJobIds: new Set(),
      olderThan: new Date(Date.now() - 7 * 24 * 60 * 60_000),
    });

    expect(report.removed).toContain(canonicalFirst);
    await expect(fs.stat(first.cwd)).rejects.toThrow();
    await expect(fs.stat(second.cwd)).resolves.toBeDefined();
    const listed = await manager.listWorktrees(first.repos[0]!.repoDir);
    expect(listed).not.toContain(canonicalFirst);
    expect(listed).toContain(canonicalSecond);
  });
});

function translateClone(args: readonly string[], remote: string): string[] {
  if (args[0] !== 'clone') return [...args];
  const option = args[1];
  const destination = args[3];
  if (!option || !destination) throw new Error('unexpected clone arguments');
  return ['clone', option, remote, destination];
}
