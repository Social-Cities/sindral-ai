import { createHmac, timingSafeEqual } from 'node:crypto';
import { chatTriggersFeedback } from '@sindral/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { RouteOptions } from '../context.js';
import { badRequest, serviceUnavailable, unauthorized } from '../errors.js';

export const SINDRAL_MARKER = '<!-- sindral -->';

export function verifyGitHubSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

interface GitHubUser {
  login?: string;
  type?: string;
}
interface GitHubComment {
  id?: number | string;
  body?: string;
  user?: GitHubUser;
}
interface GitHubWebhookPayload {
  action?: string;
  comment?: GitHubComment;
  issue?: { pull_request?: { html_url?: string } | null; html_url?: string };
  pull_request?: { html_url?: string };
}

/** Extract the PR URL and comment from supported events; null means "ignore". */
export function extractPrComment(eventName: string | undefined, payload: GitHubWebhookPayload): { prUrl: string; comment: GitHubComment } | null {
  if (payload.action !== 'created' || !payload.comment) return null;
  if (eventName === 'issue_comment') {
    if (!payload.issue?.pull_request) return null;
    const prUrl = payload.issue.pull_request.html_url ?? payload.issue.html_url;
    return prUrl ? { prUrl, comment: payload.comment } : null;
  }
  if (eventName === 'pull_request_review_comment') {
    const prUrl = payload.pull_request?.html_url;
    return prUrl ? { prUrl, comment: payload.comment } : null;
  }
  return null;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export const webhookRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  // Keep the raw body for HMAC verification; scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = raw;
    try {
      done(null, raw.length > 0 ? (JSON.parse(raw) as unknown) : {});
    } catch {
      done(badRequest('Malformed JSON body'), undefined);
    }
  });

  app.post('/api/webhooks/github', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const secret = ctx.config.githubWebhookSecret;
    if (!secret) throw serviceUnavailable('GitHub webhook secret is not configured');
    const raw = request.rawBody;
    if (raw === null || !verifyGitHubSignature(secret, raw, headerValue(request, 'x-hub-signature-256'))) {
      throw unauthorized('Invalid webhook signature');
    }

    const eventName = headerValue(request, 'x-github-event');
    const payload = (request.body ?? {}) as GitHubWebhookPayload;
    const extracted = extractPrComment(eventName, payload);
    if (!extracted) return reply.code(202).send({ ok: true, ignored: 'unsupported event' });
    const { prUrl, comment } = extracted;
    const body = comment.body ?? '';
    if (comment.user?.type === 'Bot' || body.includes(SINDRAL_MARKER) || comment.id === undefined || body.trim() === '') {
      return reply.code(202).send({ ok: true, ignored: 'bot or marker comment' });
    }

    const task = await ctx.repo.findTaskByPrUrl(prUrl);
    if (!task) return reply.code(202).send({ ok: true, ignored: 'no task for pull request' });

    const login = comment.user?.login ?? 'someone';
    const content = `@${login} on GitHub:\n\n${body}`;
    const workflow = await ctx.orchestrator.resolveWorkflow(task.userId, task);
    const triggers = workflow ? chatTriggersFeedback(task, workflow) : false;
    const { message } = await ctx.orchestrator.postUserMessage(task.userId, task.id, content, 'github', String(comment.id));
    return reply.code(200).send({ ok: true, duplicate: message === null, feedback: message !== null && triggers });
  });
};
