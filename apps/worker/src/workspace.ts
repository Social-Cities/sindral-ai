import fs from 'node:fs/promises';
import path from 'node:path';
import { assertBranchName, gitAuth, gitIn, type GitAuth, type GitRunner } from './git.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { workdirPaths } from './config.js';

export interface RepoRef {
  owner: string;
  name: string;
  /** `owner/name` */
  full: string;
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

export function parseRepo(spec: string): RepoRef {
  const parts = spec.trim().split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !REPO_PART.test(owner) || !REPO_PART.test(name) || isDotName(owner) || isDotName(name)) {
    throw new Error(`Invalid repository ${JSON.stringify(spec)}; expected owner/name`);
  }
  return { owner, name: name.replace(/\.git$/, ''), full: `${owner}/${name.replace(/\.git$/, '')}` };
}

function isDotName(part: string): boolean {
  return part === '.' || part === '..';
}

/** Task keys become directory names; anything outside a safe charset is replaced. */
export function sanitizeTaskKey(key: string): string {
  const cleaned = key.trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[_-]+/, '').slice(0, 80);
  if (!cleaned) throw new Error(`Invalid task key ${JSON.stringify(key)}`);
  return cleaned;
}

export function deriveBranch(branch: string | null | undefined, taskKey: string): string {
  const candidate = branch && branch.trim() ? branch.trim() : `sindral/${sanitizeTaskKey(taskKey).toLowerCase()}`;
  return assertBranchName(candidate);
}

export function repoDir(workdir: string, repo: RepoRef): string {
  return path.join(workdirPaths(workdir).repos, `${repo.owner}__${repo.name}`);
}

export function worktreeDir(workdir: string, taskKey: string, repo: RepoRef): string {
  return path.join(workdirPaths(workdir).worktrees, sanitizeTaskKey(taskKey), repo.name);
}

export function tmpDir(workdir: string, taskKey: string): string {
  return path.join(workdirPaths(workdir).tmp, sanitizeTaskKey(taskKey));
}

export interface RepoWorkspace {
  repo: RepoRef;
  /** Base clone shared by all worktrees of this repository. */
  repoDir: string;
  /** Worktree for this task. */
  dir: string;
  branch: string;
  baseBranch: string;
  /** True when the branch already existed on origin (feedback pass). */
  resumed: boolean;
}

export interface Workspace {
  taskKey: string;
  /** Agent working directory: first repo worktree, or the tmp dir for non-code tasks. */
  cwd: string;
  repos: RepoWorkspace[];
}

export interface PrepareOptions {
  taskKey: string;
  repos: string[];
  branch: string | null;
  baseBranch: string | null;
  githubToken: string | null;
}

export type GitFactory = (cwd: string, auth: GitAuth) => GitRunner;

export interface CleanupOptions {
  activeTaskKeys: Set<string>;
  activeJobIds: Set<string>;
  /** Entries with an mtime newer than this instant are retained. */
  olderThan: Date;
  dryRun?: boolean;
}

export interface CleanupReport {
  removed: string[];
  wouldRemove: string[];
  keptActive: string[];
  keptRecent: string[];
}

/** Resolve both paths after creation and reject symlink escapes from root. */
export async function assertPathContained(root: string, candidate: string): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Path escapes worker root: ${candidate}`);
  }
  return realCandidate;
}

export class WorkspaceManager {
  private readonly paths;
  private readonly log: Logger;
  private readonly git: GitFactory;

  constructor(
    readonly workdir: string,
    opts: { logger?: Logger; git?: GitFactory } = {},
  ) {
    this.paths = workdirPaths(workdir);
    this.log = opts.logger ?? silentLogger();
    this.git = opts.git ?? gitIn;
  }

  async prepare(opts: PrepareOptions): Promise<Workspace> {
    await fs.mkdir(this.workdir, { recursive: true, mode: 0o700 });
    const taskKey = sanitizeTaskKey(opts.taskKey);
    if (opts.repos.length === 0) {
      const cwd = tmpDir(this.workdir, taskKey);
      await fs.mkdir(cwd, { recursive: true });
      await assertPathContained(this.workdir, cwd);
      await touch(cwd);
      return { taskKey, cwd, repos: [] };
    }
    const auth = gitAuth(opts.githubToken);
    const branch = deriveBranch(opts.branch, taskKey);
    const repos: RepoWorkspace[] = [];
    for (const spec of opts.repos) {
      const repo = parseRepo(spec);
      const base = await this.ensureRepo(repo, auth);
      const baseBranch = opts.baseBranch ? assertBranchName(opts.baseBranch) : await this.defaultBranch(base);
      const dir = worktreeDir(this.workdir, taskKey, repo);
      const resumed = await this.ensureWorktree({ repoDir: base, dir, branch, baseBranch, auth });
      await touch(path.dirname(dir));
      repos.push({ repo, repoDir: base, dir, branch, baseBranch, resumed });
    }
    const first = repos[0];
    if (!first) throw new Error('no repositories prepared');
    return { taskKey, cwd: first.dir, repos };
  }

  /** Clones the repository once, then fetches before every job. */
  async ensureRepo(repo: RepoRef, auth: GitAuth): Promise<string> {
    const dir = repoDir(this.workdir, repo);
    await fs.mkdir(this.paths.repos, { recursive: true });
    await assertPathContained(this.workdir, this.paths.repos);
    if (!(await exists(path.join(dir, '.git')))) {
      this.log.info({ repo: repo.full }, 'cloning repository');
      await fs.rm(dir, { recursive: true, force: true });
      await this.git(this.paths.repos, auth)(['clone', '--no-checkout', `https://github.com/${repo.full}.git`, dir]);
    }
    if (await exists(dir)) await assertPathContained(this.paths.repos, dir);
    const git = this.git(dir, auth);
    await git(['fetch', '--prune', 'origin']);
    await git.try(['worktree', 'prune']);
    return dir;
  }

  async defaultBranch(dir: string): Promise<string> {
    const git = this.git(dir, gitAuth(null));
    const sym = await git.try(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (!sym.failed && sym.exitCode === 0 && sym.stdout.trim()) {
      return assertBranchName(sym.stdout.trim().replace(/^origin\//, ''));
    }
    const show = await git.try(['remote', 'show', 'origin']);
    const match = /HEAD branch:\s*(\S+)/.exec(show.stdout);
    if (match?.[1] && match[1] !== '(unknown)') return assertBranchName(match[1]);
    return 'main';
  }

  async listWorktrees(dir: string): Promise<string[]> {
    const git = this.git(dir, gitAuth(null));
    const res = await git.try(['worktree', 'list', '--porcelain']);
    if (res.failed) return [];
    return parseWorktreeList(res.stdout);
  }

  private async ensureWorktree(opts: { repoDir: string; dir: string; branch: string; baseBranch: string; auth: GitAuth }): Promise<boolean> {
    const git = this.git(opts.repoDir, opts.auth);
    const remoteBranch = await git.try(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${opts.branch}`]);
    const resumed = !remoteBranch.failed && remoteBranch.exitCode === 0;
    const startPoint = resumed ? `origin/${opts.branch}` : `origin/${opts.baseBranch}`;

    const existing = await this.listWorktrees(opts.repoDir);
    if (existing.includes(opts.dir) && (await exists(opts.dir))) {
      await assertPathContained(this.paths.worktrees, opts.dir);
      const wt = this.git(opts.dir, opts.auth);
      await wt.try(['checkout', opts.branch]);
      if (resumed) {
        // Pick up commits pushed to the PR branch since the last pass; ignore
        // failures so local, unpushed work is never discarded.
        const ff = await wt.try(['merge', '--ff-only', startPoint]);
        if (ff.failed || ff.exitCode !== 0) this.log.warn({ dir: opts.dir, branch: opts.branch }, 'could not fast-forward existing worktree');
      }
      return resumed;
    }

    await fs.rm(opts.dir, { recursive: true, force: true });
    await fs.mkdir(this.paths.worktrees, { recursive: true });
    await assertPathContained(this.workdir, this.paths.worktrees);
    await fs.mkdir(path.dirname(opts.dir), { recursive: true });
    await assertPathContained(this.workdir, path.dirname(opts.dir));
    await git(['worktree', 'add', '-B', opts.branch, opts.dir, startPoint]);
    if (await exists(opts.dir)) await assertPathContained(this.paths.worktrees, opts.dir);
    return resumed;
  }

  /** Removes retained local artifacts only when their task/job is inactive. */
  async clean(options: CleanupOptions): Promise<CleanupReport> {
    const report: CleanupReport = { removed: [], wouldRemove: [], keptActive: [], keptRecent: [] };
    const activeTasks = new Set([...options.activeTaskKeys].map(sanitizeTaskKey));
    const cutoff = options.olderThan.getTime();
    const remove = async (candidate: string, action?: () => Promise<unknown>) => {
      try {
        await assertPathContained(this.workdir, candidate);
      } catch (err) {
        this.log.warn({ path: candidate, err: err instanceof Error ? err.message : String(err) }, 'refusing cleanup path outside worker root');
        return;
      }
      if (options.dryRun) {
        if (!report.wouldRemove.includes(candidate)) report.wouldRemove.push(candidate);
        return;
      }
      if (action) await action();
      else await fs.rm(candidate, { recursive: true, force: true });
      if (!report.removed.includes(candidate)) report.removed.push(candidate);
    };
    const retain = async (candidate: string, active: boolean): Promise<boolean> => {
      if (active) {
        if (!report.keptActive.includes(candidate)) report.keptActive.push(candidate);
        return true;
      }
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) {
        if (stat && !report.keptRecent.includes(candidate)) report.keptRecent.push(candidate);
        return true;
      }
      return false;
    };
    const safeRoot = async (candidate: string): Promise<boolean> => {
      if (!(await exists(candidate))) return false;
      try {
        await assertPathContained(this.workdir, candidate);
        return true;
      } catch (err) {
        this.log.warn({ path: candidate, err: err instanceof Error ? err.message : String(err) }, 'refusing cleanup root outside worker root');
        return false;
      }
    };

    const repoDirs = (await safeRoot(this.paths.repos)) ? await listDirs(this.paths.repos) : [];
    for (const dir of repoDirs) {
      if (!(await safeRoot(dir))) continue;
      for (const wt of await this.listWorktrees(dir)) {
        const rel = path.relative(this.paths.worktrees, wt);
        const taskKey = rel.split(path.sep)[0];
        if (rel.startsWith('..') || path.isAbsolute(rel) || !taskKey) continue;
        const taskDir = path.join(this.paths.worktrees, taskKey);
        if (await retain(taskDir, activeTasks.has(taskKey))) continue;
        await remove(wt, async () => {
          const result = await this.git(dir, gitAuth(null)).try(['worktree', 'remove', '--force', wt]);
          if (result.failed || result.exitCode !== 0) throw new Error(result.message || result.stderr || 'git worktree remove failed');
        });
      }
      if (!options.dryRun) await this.git(dir, gitAuth(null)).try(['worktree', 'prune']);
    }
    for (const base of [this.paths.worktrees, this.paths.tmp]) {
      if (!(await safeRoot(base))) continue;
      for (const taskDir of await listDirs(base)) {
        if (await retain(taskDir, activeTasks.has(path.basename(taskDir)))) continue;
        await remove(taskDir);
      }
    }
    for (const [base, kind] of [[this.paths.results, 'file'], [this.paths.logs, 'file'], [this.paths.outputs, 'directory']] as const) {
      if (!(await safeRoot(base))) continue;
      for (const entry of await listEntries(base)) {
        if ((kind === 'directory') !== entry.isDirectory()) continue;
        const jobId = kind === 'directory' ? entry.name : entry.name.replace(/\.(json|log)$/, '');
        const candidate = path.join(base, entry.name);
        if (await retain(candidate, options.activeJobIds.has(jobId))) continue;
        await remove(candidate);
      }
    }
    return report;
  }
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export function parseWorktreeEntries(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

export function parseWorktreeList(porcelain: string): string[] {
  return parseWorktreeEntries(porcelain).map((e) => e.path);
}

/** Finds the worktree that currently has `branch` checked out, if any. */
export async function findWorktreeForBranch(git: GitRunner, branch: string): Promise<string | null> {
  const res = await git.try(['worktree', 'list', '--porcelain']);
  if (res.failed) return null;
  return parseWorktreeEntries(res.stdout).find((e) => e.branch === branch)?.path ?? null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(base: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(base, e.name));
  } catch {
    return [];
  }
}

async function listEntries(base: string) {
  try {
    return await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function touch(candidate: string): Promise<void> {
  const now = new Date();
  await fs.utimes(candidate, now, now);
}
