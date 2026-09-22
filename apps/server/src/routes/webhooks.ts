import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chatTriggersFeedback } from '@sindral/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { RouteOptions } from '../context.js';
import { ConflictError } from '../db/repository.js';
import { badRequest, conflict, serviceUnavailable, unauthorized } from '../errors.js';

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
  html_url?: string;
  user?: GitHubUser;
}
interface GitHubWebhookPayload {
  action?: string;
  comment?: GitHubComment;
  issue?: { pull_request?: { html_url?: string } | null; html_url?: string };
  pull_request?: { html_url?: string; state?: string; merged?: boolean; merged_at?: string | null };
}

export function extractPrState(
  eventName: string | undefined,
  payload: GitHubWebhookPayload,
): { prUrl: string; status: 'open' | 'merged' | 'closed'; mergedAt: string | null } | null {
  if (eventName !== 'pull_request' || !payload.pull_request?.html_url) return null;
  if (payload.action === 'reopened' || payload.pull_request.state === 'open') {
    return { prUrl: payload.pull_request.html_url, status: 'open', mergedAt: null };
  }
  if (payload.action !== 'closed' && payload.pull_request.state !== 'closed') return null;
  return {
    prUrl: payload.pull_request.html_url,
    status: payload.pull_request.merged ? 'merged' : 'closed',
    mergedAt: payload.pull_request.merged ? (payload.pull_request.merged_at ?? null) : null,
  };
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
    const deliveryId = headerValue(request, 'x-github-delivery');
    if (!eventName || !deliveryId) throw badRequest('Missing GitHub event or delivery identifier');
    const payloadHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    let delivery;
    try {
      delivery = await ctx.repo.beginWebhookDelivery(deliveryId, eventName, payloadHash);
    } catch (error) {
      if (error instanceof ConflictError) throw conflict(error.message);
      throw error;
    }
    if (delivery.state === 'replay' && delivery.response) return reply.code(delivery.response.statusCode).send(delivery.response.body);
    if (delivery.state === 'busy' || !delivery.token) throw serviceUnavailable('GitHub delivery is already being processed; retry shortly');
    const finish = async (statusCode: number, body: Record<string, unknown>) => {
      await ctx.repo.finalizeWebhookDelivery(deliveryId, payloadHash, delivery.token!, { statusCode, body });
      return reply.code(statusCode).send(body);
    };

    const payload = (request.body ?? {}) as GitHubWebhookPayload;
    try {
      const prState = extractPrState(eventName, payload);
      if (prState) {
        const matched = await ctx.orchestrator.reconcilePullRequest(prState.prUrl, prState.status, prState.mergedAt);
        return finish(matched ? 200 : 202, { ok: true, ...(matched ? { reconciled: true } : { ignored: 'no task for pull request' }) });
      }
      const extracted = extractPrComment(eventName, payload);
      if (!extracted) return finish(202, { ok: true, ignored: 'unsupported event' });
      const { prUrl, comment } = extracted;
      const body = comment.body ?? '';
      const commentId = comment.id === undefined ? '' : String(comment.id);
      if (comment.user?.type === 'Bot' || body.includes(SINDRAL_MARKER) || !/^[1-9][0-9]*$/.test(commentId) || body.trim() === '') {
        return finish(202, { ok: true, ignored: 'bot or marker comment' });
      }

      const task = await ctx.repo.findTaskByPrUrl(prUrl);
      if (!task) return finish(202, { ok: true, ignored: 'no task for pull request' });

      const login = comment.user?.login ?? 'someone';
      const content = `@${login} on GitHub:\n\n${body}`;
      const feedbackKind = eventName === 'pull_request_review_comment' ? 'review_comment' : 'issue_comment';
      const fallbackCommentUrl = `${prUrl}#${feedbackKind === 'review_comment' ? 'discussion_r' : 'issuecomment-'}${commentId}`;
      const commentUrl = comment.html_url?.startsWith(`${prUrl}#`) ? comment.html_url : fallbackCommentUrl;
      const workflow = await ctx.orchestrator.resolveWorkflow(task.userId, task);
      const triggers = workflow ? chatTriggersFeedback(task, workflow) : false;
      const { message } = await ctx.orchestrator.postUserMessage(task.userId, task.id, content, 'github', commentId, {
        kind: feedbackKind,
        commentId,
        commentUrl,
        prUrl,
      });
      return finish(200, { ok: true, duplicate: message === null, feedback: triggers });
    } catch (error) {
      await ctx.repo.abandonWebhookDelivery(deliveryId, payloadHash, delivery.token);
      throw error;
    }
  });
};
