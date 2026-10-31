import { createProjectSchema, updateProjectSchema } from '@sindral/shared';
import type { CreateGitHubRepositoryInput } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { idParamsSchema, validate } from '../validate.js';

export const projectRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));
  const { repo } = ctx;

  async function createRepositories(userId: string, requests: CreateGitHubRepositoryInput[]): Promise<string[]> {
    const created: string[] = [];
    for (const request of requests) {
      const result = await ctx.github.createRepository(userId, request);
      if (!created.includes(result.fullName)) created.push(result.fullName);
    }
    return created;
  }

  app.get('/api/projects', async (request) => {
    const projects = await repo.listProjects(request.user!.id);
    return { projects };
  });

  app.post('/api/projects', async (request, reply) => {
    const input = validate(createProjectSchema, request.body);
    const repositories = [...new Set(input.repos ?? [])];
    if (input.repository) {
      const created = await ctx.github.createRepository(request.user!.id, {
        ...input.repository,
        description: input.repository.description ?? input.description,
      });
      await ctx.github.setRepositoryReadme(request.user!.id, created.fullName, {
        title: input.name,
        description: input.description,
        ...(input.projectType === 'mobile-app' ? { mobilePlatforms: input.platforms ?? ['ios', 'android'] } : {}),
      });
      if (!repositories.includes(created.fullName)) repositories.push(created.fullName);
    }
    const project = await repo.createProject(request.user!.id, { name: input.name, description: input.description, repositories, projectType: input.projectType ?? 'standard', platforms: input.projectType === 'mobile-app' ? input.platforms ?? ['ios', 'android'] : [] });
    return reply.code(201).send({ project });
  });

  app.get('/api/projects/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const project = await repo.getProject(request.user!.id, id);
    if (!project) throw notFound('Project');
    return { project };
  });

  app.patch('/api/projects/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const input = validate(updateProjectSchema, request.body);
    const existing = await repo.getProject(request.user!.id, id);
    if (!existing) throw notFound('Project');
    const projectType = input.projectType ?? existing.projectType;
    const platforms = projectType === 'mobile-app' ? input.platforms ?? (existing.platforms.length ? existing.platforms : ['ios', 'android'] as const) : [];
    if (input.platforms && projectType !== 'mobile-app') throw badRequest('Platform selection requires a mobile app project');
    const requestedCount = (input.repos ?? existing.repositories).length + (input.newRepositories?.length ?? 0);
    if (projectType === 'mobile-app' && requestedCount !== 1) throw badRequest('Mobile app projects use one monorepo');
    const created = input.newRepositories ? await createRepositories(request.user!.id, input.newRepositories) : [];
    const repositories =
      input.repos !== undefined || created.length > 0
        ? [...new Set([...(input.repos ?? existing.repositories.map((repository) => repository.repository)), ...created])]
        : undefined;
    const project = await repo.updateProject(request.user!.id, id, {
      ...(input.projectType !== undefined || input.platforms !== undefined ? { projectType, platforms: [...platforms] } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(repositories !== undefined ? { repositories } : {}),
    });
    if (!project) throw notFound('Project');
    return { project };
  });

  app.delete('/api/projects/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const ok = await repo.deleteProject(request.user!.id, id);
    if (!ok) throw notFound('Project');
    return { ok: true as const };
  });
};
