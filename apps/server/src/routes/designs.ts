import type { FastifyPluginAsync } from 'fastify';
import { approveDesignSchema, type DesignRevisionSummary } from '@sindral/shared';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { notFound } from '../errors.js';
import { idParamsSchema, validate } from '../validate.js';
import { DESIGN_PREVIEW_CSP, designPreviewHtml, designPreviewUrls, readPreviewGrant } from '../services/designs.js';

export const designRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));
  const { repo, orchestrator, hub, config } = ctx;
  app.get('/api/tasks/:id/design', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const userId = request.user!.id;
    await orchestrator.getTask(userId, id);
    const [revisions, checkpoint, input] = await Promise.all([repo.listDesignRevisions(userId, id), repo.getDesignCheckpoint(userId, id), repo.getDesignHandoff(userId, id)]);
    return {
      revisions: revisions.map(({ result, ...revision }): DesignRevisionSummary => ({ ...revision, summary: result.summary, designUrl: result.designUrl, screens: result.screens })),
      checkpointAt: checkpoint?.updatedAt ?? null,
      input,
      inputPreviewUrls: input ? designPreviewUrls(config.secretsEncryptionKey, { userId, taskId: id, revisionId: input.revisionId, input: true }, input.result) : [],
    };
  });
  app.get('/api/tasks/:id/design/revisions/:revisionId', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const revisionId = validate(idParamsSchema, { id: (request.params as { revisionId: unknown }).revisionId }).id;
    const revision = await repo.getDesignRevision(request.user!.id, revisionId);
    if (!revision || revision.taskId !== id) throw notFound('Design revision');
    return { revision, previewUrls: designPreviewUrls(config.secretsEncryptionKey, { userId: request.user!.id, taskId: id, revisionId, input: false }, revision.result) };
  });
  app.post('/api/tasks/:id/design/approve', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const input = validate(approveDesignSchema, request.body);
    const revision = await repo.approveDesignRevision(request.user!.id, id, input.revisionId, input.expectedVersion);
    hub.publish(request.user!.id, { type: 'task.updated', taskId: id });
    return { revision };
  });
};

/** The signed URL grants read access only to one revision and screen, for five minutes. */
export const designPreviewRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.get('/api/design-previews/:id', async (request, reply) => {
    const { id } = validate(idParamsSchema, request.params);
    const grant = readPreviewGrant(ctx.config.secretsEncryptionKey, (request.query as { token?: string }).token, id);
    if (!grant) throw notFound('Design preview');
    const revision = grant.input ? null : await ctx.repo.getDesignRevision(grant.userId, grant.revisionId);
    const handoff = grant.input ? await ctx.repo.getDesignHandoff(grant.userId, id) : null;
    const result = revision?.taskId === id ? revision.result : handoff?.revisionId === grant.revisionId ? handoff.result : null;
    const html = result && designPreviewHtml(result, grant.screen);
    if (!html) throw notFound('Design preview');
    reply.header('Content-Security-Policy', `${DESIGN_PREVIEW_CSP}; frame-ancestors ${ctx.config.webOrigins.join(' ')}`);
    reply.removeHeader('X-Frame-Options');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(html);
  });
};
