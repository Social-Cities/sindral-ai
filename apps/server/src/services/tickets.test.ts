import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adfToText, MAX_TICKET_RESPONSE_BYTES } from './tickets.js';
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

  it('refuses redirects and requires a JSON response', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: redirect mode is set to error'));
    expect((await importTicket('https://github.com/acme/app/issues/3')).statusCode).toBe(502);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });

    fetchMock.mockResolvedValueOnce(new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const contentType = await importTicket('https://github.com/acme/app/issues/3');
    expect(contentType.statusCode).toBe(502);
    expect(contentType.json().error.code).toBe('TICKET_RESPONSE_INVALID');

    fetchMock.mockResolvedValueOnce(new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }));
    const malformed = await importTicket('https://github.com/acme/app/issues/3');
    expect(malformed.statusCode).toBe(502);
    expect(malformed.json().error.code).toBe('TICKET_RESPONSE_INVALID');
  });

  it('rejects declared and streamed responses over one MiB', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_TICKET_RESPONSE_BYTES + 1) } }),
    );
    const declared = await importTicket('https://github.com/acme/app/issues/3');
    expect(declared.statusCode).toBe(502);
    expect(declared.json().error.code).toBe('TICKET_RESPONSE_TOO_LARGE');

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TICKET_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'application/problem+json' } }));
    const streamed = await importTicket('https://github.com/acme/app/issues/3');
    expect(streamed.statusCode).toBe(502);
    expect(streamed.json().error.code).toBe('TICKET_RESPONSE_TOO_LARGE');
  });

  it('normalizes response-stream failures', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset during body'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    const response = await importTicket('https://github.com/acme/app/issues/3');
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('TICKET_FETCH_FAILED');
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
