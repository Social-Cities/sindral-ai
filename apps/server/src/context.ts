import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import type { UserTokenVerifier } from './auth/user.js';
import type { Repository } from './db/repository.js';
import type { Hub } from './realtime/hub.js';
import type { Metrics } from './metrics.js';
import type { FetchLike } from './services/github.js';
import type { Orchestrator } from './services/orchestrator.js';
import type { SecretService } from './services/secrets.js';
import type { TicketService } from './services/tickets.js';
import type { WorkflowService } from './services/workflows.js';

export interface ClaimOptions {
  /** How long `POST /api/worker/jobs/claim` waits for work before returning an empty list. */
  waitMs: number;
  pollMs: number;
}

/** Everything a route plugin needs; built once in `buildApp` and passed as plugin options. */
export interface AppContext {
  config: AppConfig;
  repo: Repository;
  hub: Hub;
  metrics: Metrics;
  log: FastifyBaseLogger;
  fetch: FetchLike;
  userVerifier: UserTokenVerifier;
  workflows: WorkflowService;
  secrets: SecretService;
  tickets: TicketService;
  orchestrator: Orchestrator;
  claim: ClaimOptions;
  ssePingMs: number;
}

export interface RouteOptions {
  ctx: AppContext;
}
