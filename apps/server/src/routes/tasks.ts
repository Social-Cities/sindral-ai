import { assignWorkflowSchema, previewWorkflowAssignmentSchema, createTaskSchema, listTasksQuerySchema, repinWorkflowSchema, sendMessageSchema, taskActionSchema, updateTaskSchema } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
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
    if (input.newRepository && input.workflowId && !(await ctx.workflows.get(request.user!.id, input.workflowId))) {
      throw badRequest('Unknown workflow');
    }
    const { newRepository, ...taskInput } = input;
    if (newRepository) {
      const created = await ctx.github.createRepository(request.user!.id, newRepository);
      if (!taskInput.repos.includes(created.fullName)) taskInput.repos.push(created.fullName);
      if (taskInput.projectId) {
        const project = await repo.getProject(request.user!.id, taskInput.projectId);
        if (project) {
          await repo.updateProject(request.user!.id, project.id, {
            repositories: [...new Set([...project.repositories.map((repository) => repository.repository), created.fullName])],
          });
        }
      }
    }
    const task = await orchestrator.createTask(request.user!.id, taskInput);
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
    const { event, expectedVersion } = validate(taskActionSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
      throw badRequest('A valid Idempotency-Key header is required');
    }
    const task = await orchestrator.applyUserEvent(request.user!.id, id, event, expectedVersion, idempotencyKey);
    return { task };
  });

  app.post('/api/tasks/:id/agent/stop', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const task = await orchestrator.stopRunningAgentStep(request.user!.id, id);
    return { task };
  });

  app.post('/api/tasks/:id/workflow-pin', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const { expectedVersion } = validate(repinWorkflowSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
      throw badRequest('A valid Idempotency-Key header is required');
    }
    const task = await orchestrator.repinWorkflow(request.user!.id, id, expectedVersion, idempotencyKey);
    return { task };
  });

  app.post('/api/tasks/:id/workflow-assignment/preview', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const input = validate(previewWorkflowAssignmentSchema, request.body);
    return orchestrator.previewWorkflowAssignment(request.user!.id, id, input);
  });

  app.post('/api/tasks/:id/workflow-assignment', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const input = validate(assignWorkflowSchema, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) throw badRequest('A valid Idempotency-Key header is required');
    return { task: await orchestrator.assignWorkflow(request.user!.id, id, input, key) };
  });

  app.get('/api/tasks/:id/messages', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    await orchestrator.getTask(request.user!.id, id);
    return { messages: await repo.listMessages(request.user!.id, id) };
  });

  app.post('/api/tasks/:id/messages', async (request, reply) => {
    const { id } = validate(idParamsSchema, request.params);
    const { content, feedbackTarget } = validate(sendMessageSchema, request.body);
    const { message, task } = await orchestrator.postUserMessage(request.user!.id, id, content, 'web', undefined, undefined, feedbackTarget);
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
    const { repository } = validate(z.object({ repository: z.string().max(300).optional() }), request.query);
    const pullRequests = await repo.listPullRequests(request.user!.id, id);
    const selected = repository ? pullRequests.find((pr) => pr.repository === repository) : pullRequests[0];
    const prUrl = selected?.url ?? task.prUrl;
    if (!prUrl) return { files: [] };
    const ref = parsePrUrl(prUrl);
    if (!ref) return { files: [] };
    const secret = await ctx.githubOAuth.credential(request.user!.id);
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
