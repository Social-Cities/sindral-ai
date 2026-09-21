import type { MergePullRequestsJobPayload } from '@sindral/shared';
import { describe, expect, it } from 'vitest';
import { runMergePullRequests } from './merge.js';
import { failed, GH_TOKEN, ok } from './test/fixtures.js';

const payload: MergePullRequestsJobPayload = {
  kind: 'merge-pull-requests',
  pullRequests: [
    { id: 'pr-1', repository: 'acme/app', url: 'https://github.com/acme/app/pull/1', number: 1, headSha: 'a'.repeat(40), method: 'squash' },
    { id: 'pr-2', repository: 'acme/api', url: 'https://github.com/acme/api/pull/2', number: 2, headSha: 'b'.repeat(40), method: 'rebase' },
  ],
};

describe('runMergePullRequests', () => {
  it('merges in repository order with a pinned head commit and confirms GitHub state', async () => {
    const calls: string[][] = [];
    const views = new Map<string, number>();
    const result = await runMergePullRequests({
      payload,
      githubToken: GH_TOKEN,
      ghBin: 'gh',
      allowPatMerge: true,
      signal: new AbortController().signal,
      gh: async (args) => {
        calls.push([...args]);
        const url = args[2]!;
        if (args[1] === 'view') {
          const count = views.get(url) ?? 0;
          views.set(url, count + 1);
          const item = payload.pullRequests.find((pullRequest) => pullRequest.url === url)!;
          return ok(JSON.stringify(count === 0 ? { state: 'OPEN', headRefOid: item.headSha, url } : { state: 'MERGED', headRefOid: item.headSha, mergedAt: '2026-09-21T12:00:00Z', url }));
        }
        return ok();
      },
    });

    expect(result.complete).toBe(true);
    expect(result.pullRequests.every((pullRequest) => pullRequest.merged)).toBe(true);
    expect(calls.filter((args) => args[1] === 'merge')).toEqual([
      ['pr', 'merge', payload.pullRequests[0]!.url, '--repo', 'acme/app', '--squash', '--match-head-commit', 'a'.repeat(40)],
      ['pr', 'merge', payload.pullRequests[1]!.url, '--repo', 'acme/api', '--rebase', '--match-head-commit', 'b'.repeat(40)],
    ]);
  });

  it('refuses a stale head without attempting a merge', async () => {
    const calls: string[][] = [];
    const result = await runMergePullRequests({
      payload: { ...payload, pullRequests: payload.pullRequests.slice(0, 1) },
      githubToken: GH_TOKEN,
      ghBin: 'gh',
      allowPatMerge: true,
      signal: new AbortController().signal,
      gh: async (args) => {
        calls.push([...args]);
        return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'c'.repeat(40) }));
      },
    });
    expect(result.complete).toBe(false);
    expect(result.pullRequests[0]?.error).toMatch(/head changed/);
    expect(calls.some((args) => args[1] === 'merge')).toBe(false);
  });

  it('does not accept an already-merged pull request with a different head', async () => {
    const result = await runMergePullRequests({
      payload: { ...payload, pullRequests: payload.pullRequests.slice(0, 1) },
      githubToken: GH_TOKEN,
      ghBin: 'gh',
      allowPatMerge: true,
      signal: new AbortController().signal,
      gh: async () => ok(JSON.stringify({ state: 'MERGED', headRefOid: 'c'.repeat(40), mergedAt: '2026-09-21T12:00:00Z' })),
    });
    expect(result.complete).toBe(false);
    expect(result.pullRequests[0]?.error).toMatch(/does not match expected/);
  });

  it('records partial completion and skips repositories after the first failure', async () => {
    let firstMerged = false;
    const result = await runMergePullRequests({
      payload,
      githubToken: GH_TOKEN,
      ghBin: 'gh',
      allowPatMerge: true,
      signal: new AbortController().signal,
      gh: async (args) => {
        const url = args[2]!;
        if (url === payload.pullRequests[0]!.url && args[1] === 'view') {
          return ok(JSON.stringify(firstMerged ? { state: 'MERGED', mergedAt: '2026-09-21T12:00:00Z' } : { state: 'OPEN', headRefOid: 'a'.repeat(40) }));
        }
        if (url === payload.pullRequests[0]!.url && args[1] === 'merge') {
          firstMerged = true;
          return ok();
        }
        return failed('branch protection rejected the merge');
      },
    });
    expect(result.complete).toBe(false);
    expect(result.pullRequests.map((pullRequest) => pullRequest.merged)).toEqual([true, false]);
    expect(result.pullRequests[1]?.error).toMatch(/gh pr view failed/);
  });

  it('defaults to denying PAT-backed merge execution', async () => {
    const result = await runMergePullRequests({
      payload,
      githubToken: GH_TOKEN,
      ghBin: 'gh',
      allowPatMerge: false,
      signal: new AbortController().signal,
    });
    expect(result.complete).toBe(false);
    expect(result.pullRequests.every((pullRequest) => pullRequest.error?.includes('disabled'))).toBe(true);
  });
});
