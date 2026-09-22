import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitAuth, isValidBranchName } from './git.js';
import { fakeGit, failed, GH_TOKEN, ok } from './test/fixtures.js';
import { deriveBranch, parseRepo, parseWorktreeEntries, repoDir, sanitizeTaskKey, tmpDir, worktreeDir, WorkspaceManager } from './workspace.js';

describe('derivations', () => {
  it('parses and validates repositories', () => {
    expect(parseRepo('acme/widgets')).toEqual({ owner: 'acme', name: 'widgets', full: 'acme/widgets' });
    expect(parseRepo('acme/widgets.git').name).toBe('widgets');
    for (const bad of ['acme', 'a/b/c', '../x', 'acme/..', 'acme/.', 'ac me/x', 'acme/x;rm', '/x']) {
      expect(() => parseRepo(bad), bad).toThrow(/Invalid repository/);
    }
  });

  it('sanitises task keys against path traversal', () => {
    expect(sanitizeTaskKey('ENG-142')).toBe('ENG-142');
    expect(sanitizeTaskKey('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeTaskKey('a b/c')).toBe('a_b_c');
    expect(() => sanitizeTaskKey('..')).toThrow();
    expect(() => sanitizeTaskKey('   ')).toThrow();
  });

  it('derives branch names', () => {
    expect(deriveBranch(null, 'ENG-142')).toBe('sindral/eng-142');
    expect(deriveBranch('  ', 'ENG-142')).toBe('sindral/eng-142');
    expect(deriveBranch('feature/x', 'ENG-142')).toBe('feature/x');
    for (const bad of ['a..b', '-x', 'a b', 'x.lock', 'a//b', '/a', 'a/', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', '@', 'a\nb']) {
      expect(isValidBranchName(bad), bad).toBe(false);
      expect(() => deriveBranch(bad, 'ENG-1'), bad).toThrow(/Invalid git branch name/);
    }
  });

  it('keeps every derived path inside the workdir', () => {
    const workdir = '/w';
    const repo = parseRepo('acme/widgets');
    expect(repoDir(workdir, repo)).toBe(path.join('/w', 'repos', 'acme__widgets'));
    expect(worktreeDir(workdir, 'ENG-1', repo)).toBe(path.join('/w', 'worktrees', 'ENG-1', 'widgets'));
    expect(tmpDir(workdir, 'DOC-1')).toBe(path.join('/w', 'tmp', 'DOC-1'));
    for (const p of [worktreeDir(workdir, '../../escape', repo), tmpDir(workdir, '../x')]) {
      expect(path.relative(workdir, p).startsWith('..')).toBe(false);
    }
  });

  it('parses git worktree list --porcelain', () => {
    const out = ['worktree /w/repos/a', 'HEAD abc', 'bare', '', 'worktree /w/worktrees/ENG-1/a', 'HEAD def', 'branch refs/heads/sindral/eng-1', ''].join('\n');
    expect(parseWorktreeEntries(out)).toEqual([
      { path: '/w/repos/a', branch: null },
      { path: '/w/worktrees/ENG-1/a', branch: 'sindral/eng-1' },
    ]);
  });

  it('builds auth as an extraheader and never as a URL', () => {
    const auth = gitAuth(GH_TOKEN);
    expect(auth.configArgs[0]).toBe('-c');
    expect(auth.configArgs[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic /);
    expect(auth.configArgs[1]).not.toContain(GH_TOKEN);
    expect(auth.secrets).toContain(GH_TOKEN);
    expect(gitAuth(null)).toEqual({ configArgs: [], secrets: [] });
  });
});

describe('WorkspaceManager.prepare', () => {
  let workdir: string;
  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-ws-'));
  });
  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('clones once with header auth, fetches, and adds a worktree from the base branch', async () => {
    const git = fakeGit((args) => {
      if (args[0] === 'symbolic-ref') return ok('origin/main');
      if (args[0] === 'rev-parse') return failed('', 1);
      if (args[0] === 'worktree' && args[1] === 'list') return ok('');
      return undefined;
    });
    const manager = new WorkspaceManager(workdir, { git: git.factory });
    const ws = await manager.prepare({ taskKey: 'ENG-1', repos: ['acme/widgets'], branch: null, baseBranch: null, githubToken: GH_TOKEN });

    const base = path.join(workdir, 'repos', 'acme__widgets');
    const wt = path.join(workdir, 'worktrees', 'ENG-1', 'widgets');
    expect(ws.cwd).toBe(wt);
    expect(ws.repos[0]).toMatchObject({ dir: wt, repoDir: base, branch: 'sindral/eng-1', baseBranch: 'main', resumed: false });

    const clone = git.find('clone')[0];
    expect(clone?.args).toEqual(['clone', '--no-checkout', 'https://github.com/acme/widgets.git', base]);
    expect(clone?.auth.configArgs[1]).toContain('extraheader');
    expect(git.find('fetch', '--prune', 'origin')).toHaveLength(1);
    expect(git.find('worktree', 'add')[0]?.args).toEqual(['worktree', 'add', '-B', 'sindral/eng-1', wt, 'origin/main']);
    expect(git.calls.every((c) => !c.args.join(' ').includes(GH_TOKEN))).toBe(true);
  });

  it('starts from origin/<branch> when it already exists and honours an explicit base branch', async () => {
    const git = fakeGit((args) => {
      if (args[0] === 'rev-parse') return ok('abc123');
      if (args[0] === 'worktree' && args[1] === 'list') return ok('');
      return undefined;
    });
    const manager = new WorkspaceManager(workdir, { git: git.factory });
    const ws = await manager.prepare({ taskKey: 'ENG-2', repos: ['acme/widgets'], branch: 'sindral/custom', baseBranch: 'develop', githubToken: null });
    expect(ws.repos[0]?.resumed).toBe(true);
    expect(ws.repos[0]?.baseBranch).toBe('develop');
    expect(git.find('worktree', 'add')[0]?.args.at(-1)).toBe('origin/sindral/custom');
    expect(git.find('symbolic-ref')).toHaveLength(0);
  });

  it('reuses an existing worktree and fast-forwards it', async () => {
    const wt = path.join(workdir, 'worktrees', 'ENG-3', 'widgets');
    await fs.mkdir(wt, { recursive: true });
    const git = fakeGit((args) => {
      if (args[0] === 'symbolic-ref') return ok('origin/main');
      if (args[0] === 'rev-parse') return ok('abc');
      if (args[0] === 'worktree' && args[1] === 'list') return ok(`worktree ${wt}\nbranch refs/heads/sindral/eng-3\n`);
      return undefined;
    });
    const manager = new WorkspaceManager(workdir, { git: git.factory });
    await manager.prepare({ taskKey: 'ENG-3', repos: ['acme/widgets'], branch: null, baseBranch: null, githubToken: null });
    expect(git.find('worktree', 'add')).toHaveLength(0);
    expect(git.find('merge', '--ff-only', 'origin/sindral/eng-3')[0]?.cwd).toBe(wt);
  });

  it('falls back to remote show for the default branch and prepares multi-repo tasks', async () => {
    const git = fakeGit((args) => {
      if (args[0] === 'symbolic-ref') return failed('no ref', 128);
      if (args[0] === 'remote') return ok('* remote origin\n  HEAD branch: trunk\n');
      if (args[0] === 'rev-parse') return failed('', 1);
      if (args[0] === 'worktree' && args[1] === 'list') return ok('');
      return undefined;
    });
    const manager = new WorkspaceManager(workdir, { git: git.factory });
    const ws = await manager.prepare({ taskKey: 'ENG-4', repos: ['acme/widgets', 'acme/api'], branch: null, baseBranch: null, githubToken: null });
    expect(ws.repos.map((r) => r.repo.name)).toEqual(['widgets', 'api']);
    expect(ws.cwd).toBe(ws.repos[0]?.dir);
    expect(ws.repos.every((r) => r.baseBranch === 'trunk')).toBe(true);
  });

  it('uses a tmp directory for non-code tasks', async () => {
    const git = fakeGit();
    const manager = new WorkspaceManager(workdir, { git: git.factory });
    const ws = await manager.prepare({ taskKey: 'DOC-1', repos: [], branch: null, baseBranch: null, githubToken: null });
    expect(ws.cwd).toBe(path.join(workdir, 'tmp', 'DOC-1'));
    expect((await fs.stat(ws.cwd)).isDirectory()).toBe(true);
    expect(git.calls).toHaveLength(0);
  });

  it('cleans worktrees and tmp dirs of tasks that are not running', async () => {
    const base = path.join(workdir, 'repos', 'acme__widgets');
    const keep = path.join(workdir, 'worktrees', 'ENG-1', 'widgets');
    const drop = path.join(workdir, 'worktrees', 'ENG-2', 'widgets');
    const tmpKeep = path.join(workdir, 'tmp', 'DOC-1');
    const tmpDrop = path.join(workdir, 'tmp', 'DOC-2');
    for (const dir of [base, keep, drop, tmpKeep, tmpDrop]) await fs.mkdir(dir, { recursive: true });
    const git = fakeGit((args) => (args[0] === 'worktree' && args[1] === 'list' ? ok(`worktree ${base}\nbare\n\nworktree ${keep}\n\nworktree ${drop}\n`) : undefined));
    const manager = new WorkspaceManager(workdir, { git: git.factory });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    for (const dir of [path.dirname(keep), path.dirname(drop), tmpKeep, tmpDrop]) await fs.utimes(dir, old, old);
    const report = await manager.clean({
      activeTaskKeys: new Set(['ENG-1', 'DOC-1']),
      activeJobIds: new Set(),
      olderThan: new Date(Date.now() - 7 * 24 * 60 * 60_000),
    });
    expect(report.removed).toEqual(expect.arrayContaining([drop, path.dirname(drop), tmpDrop]));
    expect(report.removed).not.toContain(keep);
    expect(git.find('worktree', 'remove', '--force', drop)).toHaveLength(1);
    expect(git.find('worktree', 'remove', '--force', keep)).toHaveLength(0);
    await expect(fs.stat(tmpKeep)).resolves.toBeDefined();
    await expect(fs.stat(tmpDrop)).rejects.toThrow();
  });

  it('supports retention and dry-run cleanup for job files without touching active artifacts', async () => {
    const oldJob = '10000000-0000-4000-8000-000000000001';
    const activeJob = '20000000-0000-4000-8000-000000000002';
    const recentJob = '30000000-0000-4000-8000-000000000003';
    const paths = {
      oldResult: path.join(workdir, 'results', `${oldJob}.json`),
      activeLog: path.join(workdir, 'logs', `${activeJob}.log`),
      recentOutput: path.join(workdir, 'outputs', recentJob),
    };
    await fs.mkdir(path.dirname(paths.oldResult), { recursive: true });
    await fs.mkdir(path.dirname(paths.activeLog), { recursive: true });
    await fs.mkdir(paths.recentOutput, { recursive: true });
    await fs.writeFile(paths.oldResult, '{}');
    await fs.writeFile(paths.activeLog, 'running');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    await fs.utimes(paths.oldResult, old, old);
    await fs.utimes(paths.activeLog, old, old);

    const manager = new WorkspaceManager(workdir, { git: fakeGit().factory });
    const options = {
      activeTaskKeys: new Set<string>(),
      activeJobIds: new Set([activeJob]),
      olderThan: new Date(Date.now() - 7 * 24 * 60 * 60_000),
    };
    const preview = await manager.clean({ ...options, dryRun: true });
    expect(preview.wouldRemove).toEqual([paths.oldResult]);
    await expect(fs.stat(paths.oldResult)).resolves.toBeDefined();
    expect(preview.keptActive).toContain(paths.activeLog);
    expect(preview.keptRecent).toContain(paths.recentOutput);

    const applied = await manager.clean(options);
    expect(applied.removed).toEqual([paths.oldResult]);
    await expect(fs.stat(paths.oldResult)).rejects.toThrow();
    await expect(fs.stat(paths.activeLog)).resolves.toBeDefined();
    await expect(fs.stat(paths.recentOutput)).resolves.toBeDefined();
  });

  it('rejects a symlinked workspace that resolves outside the worker root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-outside-'));
    try {
      await fs.symlink(outside, path.join(workdir, 'tmp'));
      const manager = new WorkspaceManager(workdir, { git: fakeGit().factory });
      await expect(manager.prepare({ taskKey: 'DOC-ESCAPE', repos: [], branch: null, baseBranch: null, githubToken: null })).rejects.toThrow(/escapes worker root/);
      const escapedTask = path.join(outside, 'DOC-ESCAPE');
      const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
      await fs.utimes(escapedTask, old, old);
      const report = await manager.clean({ activeTaskKeys: new Set(), activeJobIds: new Set(), olderThan: new Date() });
      expect(report.removed).toEqual([]);
      await expect(fs.stat(escapedTask)).resolves.toBeDefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
