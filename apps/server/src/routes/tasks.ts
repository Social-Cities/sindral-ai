import { createTaskSchema, listTasksQuerySchema, sendMessageSchema, taskActionSchema, updateTaskSchema } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { fetchPrFiles, parsePrUrl } from '../services/github.js';
import { idParamsSchema, validate } from '../validate.js';

export const taskRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));
  const { orchestrator, repo } = ctx;

  app.get('/api/tasks', async (request) => {
    const query = validate(listTasksQuerySchema, request.query);
    const tasks = await repo.listTasks(request.user!.id, query);
    return { tasks };
  });

  app.post('/api/tasks', async (request, reply) => {
    const input = validate(createTaskSchema, request.body);
    const task = await orchestrator.createTask(request.user!.id, input);
    return reply.code(201).send({ task });
  });

  app.get('/api/tasks/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const task = await orchestrator.getTaskWithRelations(request.user!.id, id);
    return { task };
  });

  app.patch('/api/tasks/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const patch = validate(updateTaskSchema, request.body);
    const task = await orchestrator.updateTask(request.user!.id, id, patch);
    return { task };
  });

  app.delete('/api/tasks/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await orchestrator.deleteTask(request.user!.id, id);
    return { ok: true as const };
  });

  app.post('/api/tasks/:id/actions', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const { event } = validate(taskActionSchema, request.body);
    const task = await orchestrator.applyUserEvent(request.user!.id, id, event);
    return { task };
  });

  app.get('/api/tasks/:id/messages', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await orchestrator.getTask(request.user!.id, id);
    return { messages: await repo.listMessages(request.user!.id, id) };
  });

  app.post('/api/tasks/:id/messages', async (request, reply) => {
    const { id } = validate(idParamsSchema, request.params);
    const { content } = validate(sendMessageSchema, request.body);
    const { message, task } = await orchestrator.postUserMessage(request.user!.id, id, content, 'web');
    return reply.code(201).send({ message, task });
  });

  app.get('/api/tasks/:id/events', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await orchestrator.getTask(request.user!.id, id);
    return { events: await repo.listEvents(request.user!.id, id) };
  });

  app.get('/api/tasks/:id/artifacts', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await orchestrator.getTask(request.user!.id, id);
    return { artifacts: await repo.listArtifacts(request.user!.id, id) };
  });

  app.get('/api/tasks/:id/jobs', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await orchestrator.getTask(request.user!.id, id);
    return { jobs: await repo.listJobsForTask(request.user!.id, id) };
  });

  app.get('/api/tasks/:id/diff', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const task = await orchestrator.getTask(request.user!.id, id);
    if (!task.prUrl) return { files: [] };
    const ref = parsePrUrl(task.prUrl);
    if (!ref) return { files: [] };
    const secret = await ctx.secrets.get(request.user!.id, 'github');
    if (!secret) throw badRequest('GitHub token is not configured');
    const files = await fetchPrFiles(ctx.fetch, secret.token, ref);
    return { files };
  });

  app.get('/api/jobs/:id/logs', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const job = await repo.getJob(request.user!.id, id);
    if (!job) throw notFound('Job');
    const logs = await repo.listJobLogs(request.user!.id, id);
    return { logs: logs.map(({ id: logId, type, message, createdAt }) => ({ id: logId, type, message, createdAt })) };
  });
};
