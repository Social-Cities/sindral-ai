import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adfToText } from './tickets.js';
import { createTestApp, type TestContext } from '../test/helpers.js';

const fetchMock = vi.fn<typeof fetch>();
let ctx: TestContext;

beforeEach(async () => {
  fetchMock.mockReset();
  ctx = await createTestApp({ fetch: fetchMock });
});
afterEach(async () => {
  await ctx.app.close();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function importTicket(url: string) {
  return ctx.app.inject({ method: 'POST', url: '/api/tickets/import', headers: { authorization: `Bearer ${ctx.tokenA}` }, payload: { url } });
}

describe('ticket import', () => {
  it('rejects unsupported hosts without fetching (SSRF guard)', async () => {
    const res = await importTicket('https://evil.example.com/browse/ENG-1');
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await importTicket('http://169.254.169.254/latest')).statusCode).toBe(400);
  });

  it('imports from Linear with the configured key', async () => {
    expect((await importTicket('https://linear.app/acme/issue/ENG-12/some-title')).statusCode).toBe(400);
    await ctx.app.ctx.secrets.set(ctx.userA, 'linear', 'lin_api_xxxxxxxx');
    fetchMock.mockResolvedValueOnce(json({ data: { issue: { identifier: 'ENG-12', title: 'Fix login', description: 'Body', url: 'https://linear.app/acme/issue/ENG-12/fix-login' } } }));
    const res = await importTicket('https://linear.app/acme/issue/eng-12');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ticket: { provider: 'linear', id: 'ENG-12', title: 'Fix login', description: 'Body', url: 'https://linear.app/acme/issue/ENG-12/fix-login' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.linear.app/graphql');
    expect((init?.headers as Record<string, string>).Authorization).toBe('lin_api_xxxxxxxx');
    expect(JSON.parse(String(init?.body))).toMatchObject({ variables: { id: 'ENG-12' } });
  });

  it('imports from Jira with basic auth and renders ADF', async () => {
    await ctx.app.ctx.secrets.set(ctx.userA, 'jira', 'jira-token-1234', { email: 'me@acme.com' });
    fetchMock.mockResolvedValueOnce(
      json({
        key: 'PROJ-7',
        fields: {
          summary: 'Ship it',
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] },
        },
      }),
    );
    const res = await importTicket('https://acme.atlassian.net/browse/PROJ-7');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ticket: { provider: 'jira', id: 'PROJ-7', title: 'Ship it', description: 'Hello world\n\n- one', url: 'https://acme.atlassian.net/browse/PROJ-7' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-7?fields=summary,description');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('me@acme.com:jira-token-1234').toString('base64')}`);
  });

  it('imports GitHub issues, unauthenticated when no token is configured', async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Bug', body: null, html_url: 'https://github.com/acme/app/issues/3' }));
    const res = await importTicket('https://github.com/acme/app/issues/3');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ticket: { provider: 'github', id: 'app#3', title: 'Bug', description: '', url: 'https://github.com/acme/app/issues/3' } });
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ message: 'nope' }, 404));
    expect((await importTicket('https://github.com/acme/app/issues/4')).statusCode).toBe(404);
  });

  it('maps upstream auth failures and network errors', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    expect((await importTicket('https://github.com/acme/app/issues/3')).statusCode).toBe(400);
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await importTicket('https://github.com/acme/app/issues/3')).statusCode).toBe(502);
  });
});

describe('adfToText', () => {
  it('handles nested content, code blocks and unknown nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@bob' } }, { type: 'hardBreak' }, { type: 'text', text: 'end' }] },
        { type: 'mystery', content: [{ type: 'text', text: 'raw' }] },
      ],
    };
    expect(adfToText(doc)).toBe('Title\n\n```\nx = 1\n```\n\n@bob\nend\n\nraw');
    expect(adfToText(null)).toBe('');
    expect(adfToText('plain')).toBe('plain');
  });
});
