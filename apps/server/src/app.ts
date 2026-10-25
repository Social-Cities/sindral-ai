import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { TransitionError } from '@sindral/shared';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createUserTokenVerifier, type UserTokenVerifier } from './auth/user.js';
import type { AppConfig } from './config.js';
import type { AppContext, ClaimOptions } from './context.js';
import { ConflictError, type Repository } from './db/repository.js';
import { HttpError } from './errors.js';
import { Hub } from './realtime/hub.js';
import { Metrics } from './metrics.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { projectRoutes } from './routes/projects.js';
import { settingsRoutes } from './routes/settings.js';
import { jsonNotFound, registerStatic, spaNotFound, webDistExists } from './routes/static.js';
import { taskRoutes } from './routes/tasks.js';
import { ticketRoutes } from './routes/tickets.js';
import { webhookRoutes } from './routes/webhooks.js';
import { workerRoutes } from './routes/worker.js';
import { workerListRoutes } from './routes/workers.js';
import { workflowRoutes } from './routes/workflows.js';
import { githubRoutes } from './routes/github.js';
import { designRoutes, designPreviewRoutes } from './routes/designs.js';
import type { FetchLike } from './services/github.js';
import { Orchestrator } from './services/orchestrator.js';
import { SecretService } from './services/secrets.js';
import { TicketService } from './services/tickets.js';
import { WorkflowService } from './services/workflows.js';
import { GitHubConnectionService } from './services/githubConnection.js';
import { GitHubOAuthService } from './services/githubOAuth.js';
import { notificationServiceFromConfig, type NotificationSink } from './services/notifications.js';
import './fastify.js';

export interface AppOptions {
  config: AppConfig;
  repo: Repository;
  hub?: Hub;
  metrics?: Metrics;
  fetch?: FetchLike;
  logger?: FastifyServerOptions['logger'];
  userVerifier?: UserTokenVerifier;
  notifications?: NotificationSink;
  claim?: ClaimOptions;
  /** 0 disables the stale-job sweeper (tests). */
  sweeperIntervalMs?: number;
  ssePingMs?: number;
  /** Vercel streams end before the function deadline and refresh from durable state. */
  sseMaxDurationMs?: number;
  sseRefreshMs?: number;
  /** Set false to skip serving `apps/web/dist` even when present. */
  serveWeb?: boolean;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'headers.authorization',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.secret',
  '*.githubToken',
  '*.credentials',
  '*.ciphertext',
];

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, repo } = options;
  const metrics = options.metrics ?? new Metrics();
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    bodyLimit: (config.runtime === 'vercel' ? 4 : 16) * 1024 * 1024,
  });

  const supabaseOrigin = new URL(config.supabaseUrl).origin;
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ['https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", supabaseOrigin],
        'object-src': ["'none'"],
        'frame-src': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: true,
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  });
  await app.register(cors, {
    origin: config.webOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.decorateRequest('user', null);
  app.decorateRequest('worker', null);
  app.decorateRequest('rawBody', null);

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      if (error.code === 'VALIDATION_ERROR') metrics.inc('sindral_validation_failures_total', { surface: request.url.startsWith('/api/worker') ? 'worker' : 'api' });
      if (error.code === 'CONFLICT' && request.url.includes('/actions')) metrics.inc('sindral_transition_conflicts_total', { reason: 'stale-or-concurrent' });
      if (request.url.startsWith('/api/webhooks/')) metrics.inc('sindral_webhook_failures_total', { code: error.code });
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
    }
    if (error instanceof TransitionError) {
      if (request.url.startsWith('/api/webhooks/')) metrics.inc('sindral_webhook_failures_total', { code: 'INVALID_TRANSITION' });
      metrics.inc('sindral_transition_conflicts_total', { reason: error.code });
      return reply.code(409).send({ error: { code: 'INVALID_TRANSITION', message: error.message, details: { reason: error.code } } });
    }
    if (error instanceof ConflictError) {
      if (request.url.startsWith('/api/webhooks/')) metrics.inc('sindral_webhook_failures_total', { code: 'CONFLICT' });
      metrics.inc('sindral_transition_conflicts_total', { reason: 'repository' });
      return reply.code(409).send({ error: { code: 'CONFLICT', message: error.message } });
    }
    const fastifyError = error as Partial<FastifyError>;
    const status = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (status >= 400 && status < 500) {
      const code = status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : (fastifyError.code ?? 'BAD_REQUEST');
      return reply.code(status).send({ error: { code, message: fastifyError.message ?? 'Bad request' } });
    }
    if (request.url.startsWith('/api/webhooks/')) metrics.inc('sindral_webhook_failures_total', { code: 'INTERNAL_ERROR' });
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const hub = options.hub ?? new Hub();
  const fetchImpl = options.fetch ?? fetch;
  const workflows = new WorkflowService(repo);
  const secrets = new SecretService(repo, config.secretsEncryptionKey);
  const githubOAuth = new GitHubOAuthService(config, secrets, fetchImpl);
  const notifications = options.notifications ?? notificationServiceFromConfig(config, repo, app.log);
  const orchestrator = new Orchestrator({ repo, hub, workflows, log: app.log, metrics, autoMergeEnabled: config.autoMergeEnabled, notifications });
  const ctx: AppContext = {
    config,
    repo,
    hub,
    metrics,
    log: app.log,
    fetch: fetchImpl,
    userVerifier: options.userVerifier ?? createUserTokenVerifier({ supabaseUrl: config.supabaseUrl, jwtSecret: config.supabaseJwtSecret }),
    workflows,
    secrets,
    tickets: new TicketService(secrets, githubOAuth, fetchImpl),
    github: new GitHubConnectionService(githubOAuth, fetchImpl),
    githubOAuth,
    notifications,
    orchestrator,
    claim: options.claim ?? { waitMs: 20_000, pollMs: 2_000 },
    ssePingMs: options.ssePingMs ?? 25_000,
    sseMaxDurationMs: options.sseMaxDurationMs ?? (config.runtime === 'vercel' ? 55_000 : 0),
    sseRefreshMs: options.sseRefreshMs ?? (config.runtime === 'vercel' ? 5_000 : 0),
  };
  app.decorate('ctx', ctx);

  await app.register(healthRoutes);
  await app.register(metricsRoutes, { ctx });
  await app.register(maintenanceRoutes, { ctx });
  await app.register(projectRoutes, { ctx });
  await app.register(taskRoutes, { ctx });
  await app.register(designRoutes, { ctx });
  await app.register(designPreviewRoutes, { ctx });
  await app.register(workflowRoutes, { ctx });
  await app.register(workerListRoutes, { ctx });
  await app.register(settingsRoutes, { ctx });
  await app.register(githubRoutes, { ctx });
  await app.register(ticketRoutes, { ctx });
  await app.register(eventRoutes, { ctx });
  await app.register(webhookRoutes, { ctx });
  await app.register(workerRoutes, { ctx });

  if (config.runtime !== 'vercel' && options.serveWeb !== false && webDistExists(config.webDistDir)) {
    await registerStatic(app, config.webDistDir);
    app.setNotFoundHandler(spaNotFound);
    app.log.info({ dir: config.webDistDir }, 'serving web UI');
  } else {
    app.setNotFoundHandler(jsonNotFound);
  }

  const sweeperInterval = config.runtime === 'vercel' ? 0 : (options.sweeperIntervalMs ?? 60_000);
  if (sweeperInterval > 0) {
    let timer: NodeJS.Timeout | null = null;
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        orchestrator.sweepStaleJobs().catch((err: unknown) => app.log.error({ err }, 'stale job sweep failed'));
      }, sweeperInterval);
      timer.unref();
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
