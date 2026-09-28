import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRebaseStack } from './rebase.js';
import { Redactor } from './redact.js';
import { fakeGit, failed, GH_TOKEN, ok } from './test/fixtures.js';
import { WorkspaceManager } from './workspace.js';

describe('runRebaseStack', () => {
  let workdir: string;
  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-rebase-'));
  });
  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  const payload = {
    kind: 'rebase-stack' as const,
    repos: ['acme/widgets'],
    stack: [
      { taskId: 't1', branch: 'sindral/eng-1', baseBranch: 'main' },
      { taskId: 't2', branch: 'sindral/eng-2', baseBranch: 'sindral/eng-1' },
      { taskId: 't3', branch: 'sindral/eng-3', baseBranch: 'sindral/eng-2' },
    ],
  };

  it('rebases in order, stops at the first conflict, aborts it and skips the rest', async () => {
    const sourceSha = 'a'.repeat(40);
    const targetSha = 'b'.repeat(40);
    const rebasedSha = 'c'.repeat(40);
    const git = fakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return ok('');
      if (args[0] === 'rev-parse' && args[1] === 'origin/sindral/eng-2') return ok(sourceSha);
      if (args[0] === 'rev-parse' && args[1] === 'origin/sindral/eng-1') return ok(targetSha);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(rebasedSha);
      if (args.includes('rebase') && args.includes('origin/sindral/eng-1')) return failed('CONFLICT (content): Merge conflict in a.ts', 1);
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) return ok('a.ts\0');
      return undefined;
    });
    const workspaces = new WorkspaceManager(workdir, { git: git.factory });
    const redactor = new Redactor();
    const progress: string[] = [];
    const result = await runRebaseStack({ payload, workspaces, githubToken: GH_TOKEN, redactor, git: git.factory, onProgress: (m) => progress.push(m) });

    expect(result.kind).toBe('rebase');
    expect(result.rebased).toEqual([
      { taskId: 't1', branch: 'sindral/eng-1', ok: true, headSha: rebasedSha },
      {
        taskId: 't2',
        branch: 'sindral/eng-2',
        ok: false,
        error: expect.stringContaining('CONFLICT'),
        conflict: { repository: 'acme/widgets', baseBranch: 'sindral/eng-1', sourceSha, targetSha, conflictedPaths: ['a.ts'] },
      },
    ]);
    expect(result.summary).toMatch(/Rebased 1\/3.*stopped at sindral\/eng-2.*1 later branch skipped/);
    expect(git.find('rebase', '--abort')).toHaveLength(1);
    expect(git.find('push', '--force-with-lease', 'origin', 'sindral/eng-1:sindral/eng-1')).toHaveLength(1);
    expect(git.find('push', '--force-with-lease', 'origin', 'sindral/eng-2:sindral/eng-2')).toHaveLength(0);
    expect(git.calls.some((c) => c.args.includes('sindral/eng-3'))).toBe(false);
    expect(progress).toEqual(['Rebasing sindral/eng-1 onto main', 'Rebasing sindral/eng-2 onto sindral/eng-1']);
    // Each branch gets its own worktree, fetched before rebasing.
    expect(git.find('worktree', 'add')).toHaveLength(2);
    expect(git.find('fetch', '--prune', 'origin').length).toBeGreaterThanOrEqual(3);
    expect(git.calls.every((c) => !c.args.join(' ').includes(GH_TOKEN))).toBe(true);
  });

  it('reuses a worktree that already has the branch checked out and reports full success', async () => {
    const existing = path.join(workdir, 'worktrees', 'ENG-1', 'widgets');
    await fs.mkdir(existing, { recursive: true });
    const git = fakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return ok(`worktree ${existing}\nbranch refs/heads/sindral/eng-1\n`);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('d'.repeat(40));
      return undefined;
    });
    const workspaces = new WorkspaceManager(workdir, { git: git.factory });
    const result = await runRebaseStack({ payload: { ...payload, stack: payload.stack.slice(0, 1) }, workspaces, githubToken: null, redactor: new Redactor(), git: git.factory });
    expect(result.rebased).toEqual([{ taskId: 't1', branch: 'sindral/eng-1', ok: true, headSha: 'd'.repeat(40) }]);
    expect(result.summary).toBe('Rebased 1/1 branches successfully');
    expect(git.find('worktree', 'add')).toHaveLength(0);
    expect(git.calls.find((c) => c.args.includes('rebase'))?.cwd).toBe(existing);
  });

  it('rejects invalid branch names before touching git', async () => {
    const git = fakeGit();
    const workspaces = new WorkspaceManager(workdir, { git: git.factory });
    const result = await runRebaseStack({
      payload: { ...payload, stack: [{ taskId: 't1', branch: 'bad..name', baseBranch: 'main' }] },
      workspaces,
      githubToken: null,
      redactor: new Redactor(),
      git: git.factory,
    }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Invalid git branch name/);
  });
});
