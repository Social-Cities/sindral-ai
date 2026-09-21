import type { MergePullRequestsJobPayload, MergeResult } from '@sindral/shared';
import { ghRunner, type GhRunner } from './github.js';

interface MergeOptions {
  payload: MergePullRequestsJobPayload;
  githubToken: string | null;
  ghBin: string;
  allowPatMerge: boolean;
  gh?: GhRunner;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

interface PrView {
  state?: string;
  headRefOid?: string;
  mergedAt?: string | null;
  url?: string;
}

export async function runMergePullRequests(options: MergeOptions): Promise<MergeResult> {
  const { payload } = options;
  if (!options.githubToken) return failedAll(payload, 'GitHub credentials are unavailable');
  if (!options.allowPatMerge) {
    return failedAll(payload, 'Merging with a personal access token is disabled; configure GitHub App credentials or explicitly enable internal PAT merges');
  }
  const gh = options.gh ?? ghRunner(options.ghBin, options.githubToken);
  const results: MergeResult['pullRequests'] = [];
  let stopped = false;

  for (const pullRequest of payload.pullRequests) {
    if (stopped) {
      results.push(baseResult(pullRequest, false, 'Skipped after an earlier pull request failed to merge'));
      continue;
    }
    if (options.signal.aborted) throw new Error(String(options.signal.reason ?? 'merge cancelled'));
    options.onProgress?.(`Checking ${pullRequest.repository}#${pullRequest.number}`);
    try {
      const before = await view(gh, pullRequest.repository, pullRequest.url, options.signal);
      if (before.state === 'MERGED') {
        if (before.headRefOid !== pullRequest.headSha) {
          throw new Error(`Merged pull request head ${before.headRefOid ?? 'unknown'} does not match expected ${pullRequest.headSha}`);
        }
        results.push({ ...baseResult(pullRequest, true), ...(before.mergedAt ? { mergedAt: before.mergedAt } : {}) });
        continue;
      }
      if (before.state !== 'OPEN') throw new Error(`Pull request is ${before.state?.toLowerCase() || 'not open'}`);
      if (before.headRefOid !== pullRequest.headSha) {
        throw new Error(`Pull request head changed from ${pullRequest.headSha} to ${before.headRefOid ?? 'unknown'}`);
      }

      options.onProgress?.(`Merging ${pullRequest.repository}#${pullRequest.number}`);
      const methodFlag = pullRequest.method === 'merge' ? '--merge' : pullRequest.method === 'rebase' ? '--rebase' : '--squash';
      const merged = await gh(
        ['pr', 'merge', pullRequest.url, '--repo', pullRequest.repository, methodFlag, '--match-head-commit', pullRequest.headSha],
        { signal: options.signal },
      );
      if (merged.failed || merged.exitCode !== 0) throw new Error(commandFailure('gh pr merge', merged));
      const after = await view(gh, pullRequest.repository, pullRequest.url, options.signal);
      if (after.state !== 'MERGED') throw new Error(`GitHub did not confirm the pull request as merged (state: ${after.state ?? 'unknown'})`);
      results.push({ ...baseResult(pullRequest, true), ...(after.mergedAt ? { mergedAt: after.mergedAt } : {}) });
    } catch (error) {
      results.push(baseResult(pullRequest, false, error instanceof Error ? error.message : String(error)));
      stopped = true;
    }
  }

  const complete = results.length === payload.pullRequests.length && results.every((result) => result.merged);
  const mergedCount = results.filter((result) => result.merged).length;
  return {
    kind: 'merge',
    complete,
    summary: complete
      ? `Merged ${mergedCount} pull request${mergedCount === 1 ? '' : 's'}.`
      : `Merged ${mergedCount} of ${payload.pullRequests.length} pull requests; the task requires attention.`,
    pullRequests: results,
  };
}

async function view(gh: GhRunner, repository: string, url: string, signal: AbortSignal): Promise<PrView> {
  const result = await gh(['pr', 'view', url, '--repo', repository, '--json', 'state,headRefOid,mergedAt,url'], { signal });
  if (result.failed || result.exitCode !== 0) throw new Error(commandFailure('gh pr view', result));
  try {
    return JSON.parse(result.stdout) as PrView;
  } catch {
    throw new Error(`gh pr view returned invalid JSON: ${result.stdout.slice(0, 200)}`);
  }
}

function commandFailure(command: string, result: { exitCode: number | null; code: string | null; stderr: string; stdout: string; message: string }): string {
  const detail = result.stderr.trim() || result.stdout.trim() || result.message;
  return `${command} failed (exit ${result.exitCode ?? result.code ?? '?'}): ${detail}`;
}

function baseResult(
  pullRequest: MergePullRequestsJobPayload['pullRequests'][number],
  merged: boolean,
  error?: string,
): MergeResult['pullRequests'][number] {
  return { id: pullRequest.id, repository: pullRequest.repository, url: pullRequest.url, merged, ...(error ? { error } : {}) };
}

function failedAll(payload: MergePullRequestsJobPayload, error: string): MergeResult {
  return {
    kind: 'merge',
    complete: false,
    summary: error,
    pullRequests: payload.pullRequests.map((pullRequest) => baseResult(pullRequest, false, error)),
  };
}
