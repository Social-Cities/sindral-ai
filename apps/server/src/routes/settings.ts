import { createWorkerKeySchema, pushDeviceSchema, setSecretSchema } from '@sindral/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth/user.js';
import type { RouteOptions } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { generateWorkerKey } from '../services/crypto.js';
import { idParamsSchema, providerParamsSchema, validate } from '../validate.js';

export const settingsRoutes: FastifyPluginAsync<RouteOptions> = async (app, { ctx }) => {
  app.addHook('onRequest', requireUser(ctx.userVerifier));
  const { repo, secrets } = ctx;

  app.get('/api/me', async (request) => {
    const user = request.user!;
    const profile = await repo.ensureProfile(user.id, user.email ? user.email.split('@')[0] ?? null : null);
    return { user: { id: user.id, email: user.email, displayName: profile.displayName } };
  });

  app.get('/api/settings/worker-keys', async (request) => ({ keys: await repo.listWorkerKeys(request.user!.id) }));

  app.post(
    '/api/settings/worker-keys',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { name } = validate(createWorkerKeySchema, request.body);
      const generated = generateWorkerKey();
      const key = await repo.createWorkerKey(request.user!.id, { name, keyHash: generated.hash, keyPrefix: generated.prefix });
      // The plaintext secret is returned exactly once and never stored.
      return reply.code(201).send({ key, secret: generated.secret });
    },
  );

  app.delete('/api/settings/worker-keys/:id', async (request) => {
    const { id } = validate(idParamsSchema, request.params);
    const found = await repo.revokeWorkerKey(request.user!.id, id);
    if (!found) throw notFound('Worker key');
    return { ok: true as const };
  });

  app.get('/api/settings/secrets', async (request) => ({ secrets: await secrets.statuses(request.user!.id) }));

  app.put('/api/settings/secrets', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const input = validate(setSecretSchema, request.body);
    if (input.provider === 'jira' && !input.email) throw badRequest('Jira requires the account email');
    const metadata = input.provider === 'jira' ? { email: input.email } : input.provider === 'github' ? { source: 'pat' } : {};
    const secret = await secrets.set(request.user!.id, input.provider, input.token, metadata);
    return { secret };
  });

  app.delete('/api/settings/secrets/:provider', async (request) => {
    const { provider } = validate(providerParamsSchema, request.params);
    await secrets.remove(request.user!.id, provider);
    return { ok: true as const };
  });

  app.put('/api/settings/push-device', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = validate(pushDeviceSchema, request.body);
    const device = await repo.upsertPushDevice(request.user!.id, input);
    return reply.code(201).send({ device });
  });

  app.delete('/api/settings/push-device', async (request) => {
    const input = validate(pushDeviceSchema, request.body);
    await repo.deletePushDevice(request.user!.id, input.platform, input.environment, input.token);
    return { ok: true as const };
  });
};
