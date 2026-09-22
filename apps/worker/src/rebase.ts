import fs from 'node:fs/promises';
import path from 'node:path';
import type { RebaseResult, RebaseStackJobPayload } from '@sindral/shared';
import { assertBranchName, gitAuth, gitIn } from './git.js';
import type { Redactor } from './redact.js';
import { assertPathContained, findWorktreeForBranch, parseRepo, worktreeDir, type GitFactory, type WorkspaceManager } from './workspace.js';

export interface RebaseStackOptions {
  payload: RebaseStackJobPayload;
  workspaces: WorkspaceManager;
  githubToken: string | null;
  redactor: Redactor;
  git?: GitFactory;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/**
 * Rebases each branch of a subtask stack onto its base, in order. A conflict
 * stops the whole stack: later entries are based on the failed one, so
 * rebasing them would only compound the damage.
 */
export async function runRebaseStack(opts: RebaseStackOptions): Promise<RebaseResult> {
  const { payload } = opts;
  const gitFactory = opts.git ?? gitIn;
  const repoSpec = payload.repos[0];
  if (!repoSpec) throw new Error('rebase-stack job has no repository');
  const repo = parseRepo(repoSpec);
  const auth = gitAuth(opts.githubToken);
  opts.redactor.add(...auth.secrets);
  const repoDir = await opts.workspaces.ensureRepo(repo, auth);
  const repoGit = gitFactory(repoDir, auth);

  const rebased: RebaseResult['rebased'][number][] = [];
  const progress = opts.onProgress ?? (() => {});

  for (const entry of payload.stack) {
    if (opts.signal?.aborted) throw new Error(String(opts.signal.reason ?? 'aborted'));
    const branch = assertBranchName(entry.branch);
    const baseBranch = assertBranchName(entry.baseBranch);
    progress(`Rebasing ${branch} onto ${baseBranch}`);
    try {
      // Earlier entries push their branch; fetch so origin/<baseBranch> is current.
      await repoGit(['fetch', '--prune', 'origin']);
      const dir = await ensureBranchWorktree(repoGit, opts.workspaces.workdir, repo, branch, entry.taskId);
      const wt = gitFactory(dir, auth);
      await wt(['checkout', branch]);
      await wt(['reset', '--hard', `origin/${branch}`]);
      const sourceSha = (await wt(['rev-parse', `origin/${branch}`])).stdout.trim();
      const targetSha = (await wt(['rev-parse', `origin/${baseBranch}`])).stdout.trim();
      const rebase = await wt.try(['-c', 'user.name=Sindral AI', '-c', 'user.email=sindral@users.noreply.github.com', 'rebase', `origin/${baseBranch}`]);
      if (rebase.failed || rebase.exitCode !== 0) {
        const conflicts = await wt.try(['diff', '--name-only', '--diff-filter=U', '-z']);
        const conflictedPaths = conflicts.failed ? [] : parseConflictedPaths(conflicts.stdout);
        await wt.try(['rebase', '--abort']);
        const detail = opts.redactor.redact((rebase.stderr || rebase.stdout || rebase.message).trim()).slice(0, 2000);
        rebased.push({
          taskId: entry.taskId,
          branch,
          ok: false,
          error: `rebase onto ${baseBranch} failed: ${detail}`,
          ...(isSha(sourceSha) && isSha(targetSha) && conflictedPaths.length > 0
            ? { conflict: { repository: repo.full, baseBranch, sourceSha, targetSha, conflictedPaths } }
            : {}),
        });
        break;
      }
      await wt(['push', '--force-with-lease', 'origin', `${branch}:${branch}`]);
      rebased.push({ taskId: entry.taskId, branch, ok: true });
    } catch (err) {
      rebased.push({ taskId: entry.taskId, branch, ok: false, error: opts.redactor.redactError(err).slice(0, 2000) });
      break;
    }
  }

  const okCount = rebased.filter((r) => r.ok).length;
  const failed = rebased.find((r) => !r.ok);
  const skipped = payload.stack.length - rebased.length;
  const summary = failed
    ? `Rebased ${okCount}/${payload.stack.length} branches; stopped at ${failed.branch}: ${failed.error ?? 'error'}${skipped > 0 ? ` (${skipped} later branch${skipped === 1 ? '' : 'es'} skipped)` : ''}`
    : `Rebased ${okCount}/${payload.stack.length} branches successfully`;
  return { kind: 'rebase', summary, rebased };
}

const SHA_RE = /^[0-9a-f]{40}$/i;

function isSha(value: string): boolean {
  return SHA_RE.test(value);
}

export function parseConflictedPaths(output: string): string[] {
  const paths = output
    .split('\0')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(paths.filter((value) => !path.isAbsolute(value) && !value.split('/').includes('..')))];
}

async function ensureBranchWorktree(
  repoGit: ReturnType<GitFactory>,
  workdir: string,
  repo: ReturnType<typeof parseRepo>,
  branch: string,
  taskId: string,
): Promise<string> {
  const existing = await findWorktreeForBranch(repoGit, branch);
  if (existing) {
    try {
      await assertPathContained(workdir, existing);
      return existing;
    } catch {
      // A stale worktree registration is not reusable; create a fresh one.
    }
  }
  const dir = worktreeDir(workdir, `rebase__${taskId}`, repo);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(workdir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await assertPathContained(workdir, path.dirname(dir));
  await repoGit(['worktree', 'add', '-B', branch, dir, `origin/${branch}`]);
  await fs.mkdir(dir, { recursive: true });
  await assertPathContained(workdir, dir);
  return dir;
}
