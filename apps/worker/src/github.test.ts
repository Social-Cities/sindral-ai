import { describe, expect, it } from 'vitest';
import { commitAndPush, commitMessage, ensurePr, extractPrUrl, prBody, prComment, prTitle, SINDRAL_MARKER, type GhRunner } from './github.js';
import type { RunResult } from './proc.js';
import { fakeGit, failed, ok } from './test/fixtures.js';

const repo = { owner: 'acme', name: 'widgets', full: 'acme/widgets' };

function fakeGh(respond: (args: string[]) => RunResult | undefined) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    return respond([...args]) ?? ok();
  };
  return { gh, calls };
}

describe('PR text', () => {
  it('builds title, body with marker and task key, and comment', () => {
    expect(prTitle('ENG-1', 'Add thing')).toBe('ENG-1: Add thing');
    const body = prBody({ taskKey: 'ENG-1', summary: 'Did the thing.' });
    expect(body).toContain('Did the thing.');
    expect(body).toContain('Task ENG-1');
    expect(body.trim().endsWith(SINDRAL_MARKER)).toBe(true);
    expect(prComment('Fixed it').startsWith(`${SINDRAL_MARKER}\n`)).toBe(true);
    expect(prComment('Fixed it')).toContain('Fixed it');
  });

  it('uses the first non-empty summary line as the commit subject', () => {
    expect(commitMessage('ENG-1', '\n\nAdded limiter\nmore detail')).toBe('ENG-1: Added limiter');
    expect(commitMessage('ENG-1', '')).toBe('ENG-1: update');
  });

  it('extracts PR URLs from gh output', () => {
    expect(extractPrUrl('Creating pull request...\nhttps://github.com/acme/widgets/pull/12\n')).toBe('https://github.com/acme/widgets/pull/12');
    expect(extractPrUrl('nothing')).toBeNull();
  });
});

describe('ensurePr', () => {
  const base = { cwd: '/wt', repo, branch: 'sindral/eng-1', baseBranch: 'main', taskKey: 'ENG-1', taskTitle: 'Add thing', summary: 'Did it' };

  it('creates a PR when none exists', async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[1] === 'list') return ok('[]');
      if (args[1] === 'create') return ok('https://github.com/acme/widgets/pull/7\n');
      return undefined;
    });
    const result = await ensurePr({ ...base, gh });
    expect(result).toEqual({ url: 'https://github.com/acme/widgets/pull/7', created: true });
    const create = calls.find((c) => c[1] === 'create');
    expect(create).toBeDefined();
    expect(create).toEqual(expect.arrayContaining(['--repo', 'acme/widgets', '--head', 'sindral/eng-1', '--base', 'main', '--title', 'ENG-1: Add thing']));
    const body = create?.[create.indexOf('--body') + 1] ?? '';
    expect(body).toContain(SINDRAL_MARKER);
    expect(body).toContain('Task ENG-1');
    expect(calls.some((c) => c[1] === 'comment')).toBe(false);
  });

  it('comments on the existing PR instead of creating another', async () => {
    const { gh, calls } = fakeGh((args) => (args[1] === 'list' ? ok('[{"url":"https://github.com/acme/widgets/pull/3"}]') : undefined));
    const result = await ensurePr({ ...base, gh });
    expect(result).toEqual({ url: 'https://github.com/acme/widgets/pull/3', created: false });
    const comment = calls.find((c) => c[1] === 'comment');
    expect(comment?.[2]).toBe('https://github.com/acme/widgets/pull/3');
    expect(comment?.[comment.indexOf('--body') + 1]).toBe(`${SINDRAL_MARKER}\nDid it`);
    expect(calls.some((c) => c[1] === 'create')).toBe(false);
  });

  it('replies directly to an originating review comment', async () => {
    const jobId = '10000000-0000-4000-8000-000000000001';
    const feedback = {
      kind: 'review_comment' as const,
      commentId: '777',
      commentUrl: 'https://github.com/acme/widgets/pull/3#discussion_r777',
      prUrl: 'https://github.com/acme/widgets/pull/3',
    };
    const { gh, calls } = fakeGh((args) => (args[1] === 'list' ? ok('[{"url":"https://github.com/acme/widgets/pull/3"}]') : undefined));

    await ensurePr({ ...base, gh, jobId, githubFeedback: feedback });

    const reply = calls.find((args) => args.includes('repos/acme/widgets/pulls/3/comments/777/replies'));
    expect(reply).toEqual(expect.arrayContaining(['api', '--method', 'POST']));
    expect(reply?.find((arg) => arg.startsWith('body='))).toContain(`<!-- sindral:job:${jobId} -->`);
    expect(calls.some((args) => args[1] === 'comment')).toBe(false);
  });

  it('links ordinary feedback in a PR-level response and skips an existing job marker', async () => {
    const jobId = '20000000-0000-4000-8000-000000000002';
    const feedback = {
      kind: 'issue_comment' as const,
      commentId: '888',
      commentUrl: 'https://github.com/acme/widgets/pull/3#issuecomment-888',
      prUrl: 'https://github.com/acme/widgets/pull/3',
    };
    const first = fakeGh((args) => (args[1] === 'list' ? ok('[{"url":"https://github.com/acme/widgets/pull/3"}]') : undefined));
    await ensurePr({ ...base, gh: first.gh, jobId, githubFeedback: feedback });
    const body = first.calls.find((args) => args[1] === 'comment')?.at(-1) ?? '';
    expect(body).toContain(feedback.commentUrl);
    expect(body).toContain(`<!-- sindral:job:${jobId} -->`);

    const retry = fakeGh((args) => {
      if (args[1] === 'list') return ok('[{"url":"https://github.com/acme/widgets/pull/3"}]');
      if (args[0] === 'api') return ok('12345\n');
      return undefined;
    });
    await ensurePr({ ...base, gh: retry.gh, jobId, githubFeedback: feedback });
    expect(retry.calls.some((args) => args[1] === 'comment' || args.includes('--method'))).toBe(false);
  });

  it('surfaces gh failures', async () => {
    const { gh } = fakeGh((args) => (args[1] === 'list' ? failed('gh: not logged in') : undefined));
    await expect(ensurePr({ ...base, gh })).rejects.toThrow(/gh pr list failed.*not logged in/);
  });
});

describe('commitAndPush', () => {
  it('commits leftover changes as Sindral AI and force-pushes with lease', async () => {
    const git = fakeGit((args) => (args[0] === 'status' ? ok(' M src/a.ts') : undefined));
    const result = await commitAndPush(git.factory('/wt', { configArgs: [], secrets: [] }), { taskKey: 'ENG-1', summary: 'Did it', branch: 'sindral/eng-1' });
    expect(result.committed).toBe(true);
    expect(git.find('add', '-A')).toHaveLength(1);
    const commit = git.calls.find((c) => c.args.includes('commit'));
    expect(commit?.args).toContain('--author=Sindral AI <sindral@users.noreply.github.com>');
    expect(commit?.args).toContain('ENG-1: Did it');
    expect(git.find('push', '--force-with-lease', '-u', 'origin', 'sindral/eng-1:sindral/eng-1')).toHaveLength(1);
  });

  it('skips the commit when the tree is clean', async () => {
    const git = fakeGit();
    const result = await commitAndPush(git.factory('/wt', { configArgs: [], secrets: [] }), { taskKey: 'ENG-1', summary: 'Did it', branch: 'b' });
    expect(result.committed).toBe(false);
    expect(git.calls.some((c) => c.args.includes('commit'))).toBe(false);
    expect(git.find('push')).toHaveLength(1);
  });
});
