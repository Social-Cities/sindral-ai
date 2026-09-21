import { detectTicket, type DetectedTicket, type TicketImport } from '@sindral/shared';
import { badRequest, HttpError } from '../errors.js';
import type { FetchLike } from './github.js';
import type { SecretService } from './secrets.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** Best-effort Atlassian Document Format → plain text. */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention' || n.type === 'emoji') return n.attrs?.text ?? '';
  const children = Array.isArray(n.content) ? n.content.map(adfToText) : [];
  switch (n.type) {
    case 'paragraph':
    case 'heading':
      return `${children.join('')}\n\n`;
    case 'listItem':
      return `- ${children.join('').trim()}\n`;
    case 'bulletList':
    case 'orderedList':
      return `${children.join('')}\n`;
    case 'codeBlock':
      return `\`\`\`\n${children.join('')}\n\`\`\`\n\n`;
    default:
      return children.join('');
  }
}

async function request(fetchImpl: FetchLike, url: string, init: RequestInit, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, 'TICKET_FETCH_FAILED', `Could not reach ${provider}`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'TICKET_AUTH_FAILED', `${provider} rejected the configured credentials`);
  if (res.status === 404) throw new HttpError(404, 'TICKET_NOT_FOUND', `Ticket not found on ${provider}`);
  if (!res.ok) throw new HttpError(502, 'TICKET_FETCH_FAILED', `${provider} responded with ${res.status}`);
  return res.json();
}

export class TicketService {
  constructor(
    private readonly secrets: SecretService,
    private readonly fetchImpl: FetchLike,
  ) {}

  async import(userId: string, url: string): Promise<TicketImport> {
    const detected = detectTicket(url);
    if (!detected) throw badRequest('Unsupported ticket URL. Supported: Linear, Jira Cloud and GitHub issues.');
    switch (detected.provider) {
      case 'linear':
        return this.importLinear(userId, detected);
      case 'jira':
        return this.importJira(userId, detected);
      case 'github':
        return this.importGitHub(userId, detected);
    }
  }

  private async importLinear(userId: string, ticket: DetectedTicket): Promise<TicketImport> {
    const secret = await this.secrets.get(userId, 'linear');
    if (!secret) throw badRequest('Linear API key is not configured');
    const query = 'query Issue($id: String!) { issue(id: $id) { identifier title description url } }';
    const body = (await request(
      this.fetchImpl,
      'https://api.linear.app/graphql',
      {
        method: 'POST',
        headers: { Authorization: secret.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: ticket.id } }),
      },
      'Linear',
    )) as { data?: { issue?: { identifier?: string; title?: string; description?: string | null; url?: string } | null }; errors?: unknown[] };
    const issue = body.data?.issue;
    if (!issue) throw new HttpError(404, 'TICKET_NOT_FOUND', 'Linear issue not found');
    return {
      provider: 'linear',
      id: issue.identifier ?? ticket.id,
      title: issue.title ?? ticket.id,
      description: issue.description ?? '',
      url: issue.url ?? `https://linear.app/${ticket.ref.org}/issue/${ticket.id}`,
    };
  }

  private async importJira(userId: string, ticket: DetectedTicket): Promise<TicketImport> {
    const secret = await this.secrets.get(userId, 'jira');
    const email = typeof secret?.metadata.email === 'string' ? secret.metadata.email : null;
    if (!secret || !email) throw badRequest('Jira API token and email are not configured');
    const host = ticket.ref.host!;
    const basic = Buffer.from(`${email}:${secret.token}`, 'utf8').toString('base64');
    const body = (await request(
      this.fetchImpl,
      `https://${host}/rest/api/3/issue/${encodeURIComponent(ticket.id)}?fields=summary,description`,
      { headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } },
      'Jira',
    )) as { key?: string; fields?: { summary?: string; description?: unknown } };
    return {
      provider: 'jira',
      id: body.key ?? ticket.id,
      title: body.fields?.summary ?? ticket.id,
      description: adfToText(body.fields?.description).trim(),
      url: `https://${host}/browse/${body.key ?? ticket.id}`,
    };
  }

  private async importGitHub(userId: string, ticket: DetectedTicket): Promise<TicketImport> {
    const secret = await this.secrets.get(userId, 'github');
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'sindral-server' };
    if (secret) headers.Authorization = `Bearer ${secret.token}`;
    const { owner, repo, number } = ticket.ref;
    const body = (await request(
      this.fetchImpl,
      `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/issues/${number}`,
      { headers },
      'GitHub',
    )) as { title?: string; body?: string | null; html_url?: string };
    return {
      provider: 'github',
      id: ticket.id,
      title: body.title ?? ticket.id,
      description: body.body ?? '',
      url: body.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}`,
    };
  }
}
