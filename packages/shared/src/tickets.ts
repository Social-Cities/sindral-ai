export type TicketProvider = 'linear' | 'jira' | 'github';

export interface DetectedTicket {
  provider: TicketProvider;
  id: string;
  /** Provider specific coordinates used by the server to call the API. */
  ref: { org?: string; owner?: string; repo?: string; number?: number; host?: string };
}

const LINEAR_RE = /^https:\/\/linear\.app\/([a-z0-9-]+)\/issue\/([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/i;
const JIRA_RE = /^https:\/\/([a-z0-9-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#].*)?$/i;
const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#].*)?$/;

/** Detect the ticket provider from a URL. Only exact, allow-listed hosts are accepted (SSRF guard). */
export function detectTicket(url: string): DetectedTicket | null {
  const trimmed = url.trim();
  let m = LINEAR_RE.exec(trimmed);
  if (m) return { provider: 'linear', id: m[2]!.toUpperCase(), ref: { org: m[1]! } };
  m = JIRA_RE.exec(trimmed);
  if (m) return { provider: 'jira', id: m[2]!.toUpperCase(), ref: { host: m[1]!.toLowerCase() } };
  m = GITHUB_RE.exec(trimmed);
  if (m) return { provider: 'github', id: `${m[2]}#${m[3]}`, ref: { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } };
  return null;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Normalise `owner/name`, `github.com/owner/name` or a full URL into `owner/name`. */
export function normalizeRepo(input: string): string | null {
  let s = input.trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^github\.com\//i, '');
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  if (!REPO_RE.test(s)) return null;
  if (s.startsWith('.') || s.includes('..')) return null;
  return s;
}
