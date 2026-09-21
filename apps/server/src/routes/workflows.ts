import { createWorkflowSchema, updateWorkflowSchema, validateWorkflow } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import { idParamsSchema, validate } from '../validate.js';

export const workflowRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));
  const { workflows } = ctx;

  app.get('/api/workflows', async (request) => ({ workflows: await workflows.list(request.user!.id) }));

  app.post('/api/workflows', async (request, reply) => {
    const input = validate(createWorkflowSchema, request.body);
    const workflow = await workflows.create(request.user!.id, input.name, input.cloneFrom);
    return reply.code(201).send({ workflow });
  });

  app.get('/api/workflows/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const workflow = await workflows.get(request.user!.id, id);
    if (!workflow) throw notFound('Workflow');
    return { workflow };
  });

  app.put('/api/workflows/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const definition = validate(updateWorkflowSchema, request.body);
    const issues = validateWorkflow({ ...definition, id });
    if (issues.length > 0) throw new HttpError(400, 'INVALID_WORKFLOW', 'Workflow definition is invalid', issues);
    const workflow = await workflows.update(request.user!.id, id, definition);
    return { workflow };
  });

  app.delete('/api/workflows/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await workflows.remove(request.user!.id, id);
    return { ok: true as const };
  });
};
