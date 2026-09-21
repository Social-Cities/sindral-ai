import { badRequest, HttpError } from '../errors.js';

export type FetchLike = typeof fetch;

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePrUrl(url: string): PrRef | null {
  const m = PR_URL_RE.exec(url.trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

const REQUEST_TIMEOUT_MS = 10_000;

interface GitHubFileRow {
  filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
}

/** `GET /repos/{owner}/{repo}/pulls/{n}/files`, following pagination up to a sane cap. */
export async function fetchPrFiles(fetchImpl: FetchLike, token: string, ref: PrRef): Promise<PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/files?per_page=100&page=${page}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sindral-server' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(502, 'GITHUB_ERROR', `GitHub responded with ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw badRequest('Unexpected GitHub response');
    for (const row of body as GitHubFileRow[]) {
      const file: PrFile = {
        filename: String(row.filename ?? ''),
        status: String(row.status ?? 'modified'),
        additions: Number(row.additions ?? 0),
        deletions: Number(row.deletions ?? 0),
      };
      if (typeof row.patch === 'string') file.patch = row.patch;
      files.push(file);
    }
    if (body.length < 100) break;
  }
  return files;
}
