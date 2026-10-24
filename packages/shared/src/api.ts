/**
 * REST contract between the web UI / worker and the server. All routes are
 * prefixed with `/api`. User routes require `Authorization: Bearer <supabase jwt>`;
 * worker routes require `Authorization: Bearer <worker key>`.
 */
import type {
  Artifact,
  Job,
  JobDispatch,
  Message,
  Project,
  SecretStatus,
  Task,
  TaskEvent,
  TaskWithRelations,
  TicketImport,
  GitHubCatalog,
  PushDevice,
  Worker,
  WorkerKey,
  WorkflowRecord,
} from './types.js';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface ApiRoutes {
  // projects
  'GET /api/projects': { response: { projects: Project[] } };
  'POST /api/projects': { response: { project: Project } };
  'GET /api/projects/:id': { response: { project: Project } };
  'PATCH /api/projects/:id': { response: { project: Project } };
  'DELETE /api/projects/:id': { response: { ok: true } };
  // tasks
  'GET /api/tasks': { response: { tasks: Task[] } };
  'POST /api/tasks': { response: { task: Task } };
  'GET /api/tasks/:id': { response: { task: TaskWithRelations } };
  'PATCH /api/tasks/:id': { response: { task: Task } };
  'DELETE /api/tasks/:id': { response: { ok: true } };
  'POST /api/tasks/:id/actions': { response: { task: Task } };
  'POST /api/tasks/:id/agent/stop': { response: { task: Task } };
  'POST /api/tasks/:id/workflow-pin': { response: { task: Task } };
  'GET /api/tasks/:id/messages': { response: { messages: Message[] } };
  'POST /api/tasks/:id/messages': { response: { message: Message; task: Task } };
  'GET /api/tasks/:id/events': { response: { events: TaskEvent[] } };
  'GET /api/tasks/:id/artifacts': { response: { artifacts: Artifact[] } };
  'GET /api/tasks/:id/jobs': { response: { jobs: Job[] } };
  // workflows
  'GET /api/workflows': { response: { workflows: WorkflowRecord[] } };
  'POST /api/workflows': { response: { workflow: WorkflowRecord } };
  'GET /api/workflows/:id': { response: { workflow: WorkflowRecord } };
  'PUT /api/workflows/:id': { response: { workflow: WorkflowRecord } };
  'DELETE /api/workflows/:id': { response: { ok: true } };
  // workers & settings
  'GET /api/workers': { response: { workers: Worker[] } };
  'GET /api/settings/worker-keys': { response: { keys: WorkerKey[] } };
  'POST /api/settings/worker-keys': { response: { key: WorkerKey; secret: string } };
  'DELETE /api/settings/worker-keys/:id': { response: { ok: true } };
  'GET /api/settings/secrets': { response: { secrets: SecretStatus[] } };
  'PUT /api/settings/secrets': { response: { secret: SecretStatus } };
  'DELETE /api/settings/secrets/:provider': { response: { ok: true } };
  'PUT /api/settings/push-device': { response: { device: PushDevice } };
  'DELETE /api/settings/push-device': { response: { ok: true } };
  'GET /api/me': { response: { user: { id: string; email: string | null; displayName: string | null } } };
  'GET /api/github/catalog': { response: GitHubCatalog };
  'POST /api/github/connect': { request: { returnTo?: 'web' | 'ios' }; response: { url: string } };
  // tickets
  'POST /api/tickets/import': { response: { ticket: TicketImport } };
  // realtime (SSE)
  'GET /api/events': { response: never };
  // worker
  'POST /api/worker/register': { response: { workerId: string; protocolVersion: number } };
  'POST /api/worker/heartbeat': { response: { ok: true; cancelledJobIds: string[] } };
  'POST /api/worker/disconnect': { response: { ok: true } };
  'POST /api/worker/cleanup-status': { response: { workerOnline: boolean; activeJobs: { jobId: string; taskKey: string }[] } };
  'POST /api/worker/jobs/claim': { response: { jobs: JobDispatch[] } };
  'POST /api/worker/jobs/:id/events': { response: { ok: true } };
  'POST /api/worker/jobs/:id/complete': { response: { ok: true } };
  'POST /api/worker/jobs/:id/fail': { response: { ok: true } };
  'POST /api/worker/jobs/:id/cancelled': { response: { ok: true } };
}

/** Server-sent event payloads pushed to the UI on `/api/events`. */
export type ServerEvent =
  | { type: 'task.updated'; taskId: string }
  | { type: 'task.created'; taskId: string }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'worker.updated'; workerId: string }
  /** Refetch active queries from the API; safe across serverless instances. */
  | { type: 'sync' }
  | { type: 'ping' };
