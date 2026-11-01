import type {
  ApiRoutes,
  AssignWorkflowInput,
  PreviewWorkflowAssignmentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkflowInput,
  Job,
  SetSecretInput,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateWorkflowInput,
} from '@sindral/shared';
import { getAccessToken, supabase } from './supabase';
import type { DesignOverview, DesignRevision, DesignRevisionView } from '@sindral/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const API_BASE: string = import.meta.env.VITE_API_URL ?? '';

type Route = keyof ApiRoutes;
type ResponseOf<R extends Route> = ApiRoutes[R]['response'];

function isApiErrorBody(body: unknown): body is { error: { code: string; message: string; details?: unknown } } {
  if (typeof body !== 'object' || body === null) return false;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string';
}

/**
 * Fetch wrapper for the Sindral API. Prefixes `VITE_API_URL`, attaches the
 * Supabase access token, encodes/decodes JSON and throws `ApiError` on non-2xx.
 * A 401 signs the user out.
 */
export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);
  headers.set('Accept', 'application/json');
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = rest.body;
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }

  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers, body });

  if (res.status === 401) {
    await supabase.auth.signOut().catch(() => undefined);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    if (isApiErrorBody(parsed)) {
      throw new ApiError(res.status, parsed.error.code ?? 'ERROR', parsed.error.message, parsed.error.details);
    }
    throw new ApiError(res.status, 'HTTP_ERROR', text || `Request failed with status ${res.status}`);
  }
  return parsed as T;
}

// ---- tasks -----------------------------------------------------------------

export interface ListTasksParams {
  state?: string;
  workflowId?: string;
  projectId?: string;
  search?: string;
  parentTaskId?: string;
  includeSubtasks?: boolean;
}

export function listTasks(params: ListTasksParams = {}) {
  const qs = new URLSearchParams();
  if (params.state) qs.set('state', params.state);
  if (params.workflowId) qs.set('workflowId', params.workflowId);
  if (params.projectId) qs.set('projectId', params.projectId);
  if (params.search) qs.set('search', params.search);
  if (params.parentTaskId) qs.set('parentTaskId', params.parentTaskId);
  if (params.includeSubtasks) qs.set('includeSubtasks', 'true');
  const query = qs.toString();
  return apiFetch<ResponseOf<'GET /api/tasks'>>(`/api/tasks${query ? `?${query}` : ''}`);
}

export function getTask(id: string) {
  return apiFetch<ResponseOf<'GET /api/tasks/:id'>>(`/api/tasks/${encodeURIComponent(id)}`);
}

export function getTaskDesign(id: string) {
  return apiFetch<DesignOverview>(`/api/tasks/${encodeURIComponent(id)}/design`);
}
export function getDesignRevision(taskId: string, revisionId: string) {
  return apiFetch<DesignRevisionView>(`/api/tasks/${encodeURIComponent(taskId)}/design/revisions/${encodeURIComponent(revisionId)}`);
}
export function approveDesign(taskId: string, revisionId: string, expectedVersion: number) {
  return apiFetch<{ revision: DesignRevision }>(`/api/tasks/${encodeURIComponent(taskId)}/design/approve`, { method: 'POST', json: { revisionId, expectedVersion } });
}

export function createTask(input: CreateTaskInput) {
  return apiFetch<ResponseOf<'POST /api/tasks'>>('/api/tasks', { method: 'POST', json: input });
}

export function updateTask(id: string, input: UpdateTaskInput) {
  return apiFetch<ResponseOf<'PATCH /api/tasks/:id'>>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', json: input });
}

export function deleteTask(id: string) {
  return apiFetch<ResponseOf<'DELETE /api/tasks/:id'>>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function runTaskAction(id: string, event: string, expectedVersion: number, idempotencyKey = crypto.randomUUID()) {
  return apiFetch<ResponseOf<'POST /api/tasks/:id/actions'>>(`/api/tasks/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    json: { event, expectedVersion },
  });
}

export function stopAgent(id: string) {
  return apiFetch<ResponseOf<'POST /api/tasks/:id/agent/stop'>>(`/api/tasks/${encodeURIComponent(id)}/agent/stop`, { method: 'POST' });
}

export function repinTaskWorkflow(id: string, expectedVersion: number, idempotencyKey = crypto.randomUUID()) {
  return apiFetch<ResponseOf<'POST /api/tasks/:id/workflow-pin'>>(`/api/tasks/${encodeURIComponent(id)}/workflow-pin`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    json: { expectedVersion },
  });
}

export function previewTaskWorkflowAssignment(id: string, input: PreviewWorkflowAssignmentInput) {
  return apiFetch<ResponseOf<'POST /api/tasks/:id/workflow-assignment/preview'>>(`/api/tasks/${encodeURIComponent(id)}/workflow-assignment/preview`, { method: 'POST', json: input });
}

export function assignTaskWorkflow(id: string, input: AssignWorkflowInput, idempotencyKey = crypto.randomUUID()) {
  return apiFetch<ResponseOf<'POST /api/tasks/:id/workflow-assignment'>>(`/api/tasks/${encodeURIComponent(id)}/workflow-assignment`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, json: input,
  });
}

export function sendMessage(id: string, content: string, feedbackTarget?: 'bdd' | 'implementation') {
  return apiFetch<ResponseOf<'POST /api/tasks/:id/messages'>>(`/api/tasks/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    json: { content, ...(feedbackTarget ? { feedbackTarget } : {}) },
  });
}

export function getTaskJobs(id: string) {
  return apiFetch<{ jobs: Job[] }>(`/api/tasks/${encodeURIComponent(id)}/jobs`);
}

export interface JobLog {
  id: string;
  type: string;
  message: string;
  createdAt: string;
}

export function getJobLogs(jobId: string) {
  return apiFetch<{ logs: JobLog[] }>(`/api/jobs/${encodeURIComponent(jobId)}/logs`);
}

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export function getTaskDiff(id: string, repository?: string) {
  const query = repository ? `?repository=${encodeURIComponent(repository)}` : '';
  return apiFetch<{ files: DiffFile[] }>(`/api/tasks/${encodeURIComponent(id)}/diff${query}`);
}

// ---- projects --------------------------------------------------------------

export function listProjects() {
  return apiFetch<ResponseOf<'GET /api/projects'>>('/api/projects');
}

export function getProject(id: string) {
  return apiFetch<ResponseOf<'GET /api/projects/:id'>>(`/api/projects/${encodeURIComponent(id)}`);
}

export function createProject(input: CreateProjectInput) {
  return apiFetch<ResponseOf<'POST /api/projects'>>('/api/projects', { method: 'POST', json: input });
}

export function updateProject(id: string, input: UpdateProjectInput) {
  return apiFetch<ResponseOf<'PATCH /api/projects/:id'>>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', json: input });
}

export function deleteProject(id: string) {
  return apiFetch<ResponseOf<'DELETE /api/projects/:id'>>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- workflows -------------------------------------------------------------

export function listWorkflows() {
  return apiFetch<ResponseOf<'GET /api/workflows'>>('/api/workflows');
}

export function getWorkflow(id: string) {
  return apiFetch<ResponseOf<'GET /api/workflows/:id'>>(`/api/workflows/${encodeURIComponent(id)}`);
}

export function createWorkflow(input: CreateWorkflowInput) {
  return apiFetch<ResponseOf<'POST /api/workflows'>>('/api/workflows', { method: 'POST', json: input });
}

export function updateWorkflow(id: string, input: UpdateWorkflowInput) {
  return apiFetch<ResponseOf<'PUT /api/workflows/:id'>>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'PUT', json: input });
}

export function deleteWorkflow(id: string) {
  return apiFetch<ResponseOf<'DELETE /api/workflows/:id'>>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- workers & settings ----------------------------------------------------

export function listWorkers() {
  return apiFetch<ResponseOf<'GET /api/workers'>>('/api/workers');
}

export function listWorkerKeys() {
  return apiFetch<ResponseOf<'GET /api/settings/worker-keys'>>('/api/settings/worker-keys');
}

export function createWorkerKey(name: string) {
  return apiFetch<ResponseOf<'POST /api/settings/worker-keys'>>('/api/settings/worker-keys', { method: 'POST', json: { name } });
}

export function revokeWorkerKey(id: string) {
  return apiFetch<ResponseOf<'DELETE /api/settings/worker-keys/:id'>>(`/api/settings/worker-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function listSecrets() {
  return apiFetch<ResponseOf<'GET /api/settings/secrets'>>('/api/settings/secrets');
}

export function setSecret(input: SetSecretInput) {
  return apiFetch<ResponseOf<'PUT /api/settings/secrets'>>('/api/settings/secrets', { method: 'PUT', json: input });
}

export function deleteSecret(provider: SetSecretInput['provider']) {
  return apiFetch<ResponseOf<'DELETE /api/settings/secrets/:provider'>>(`/api/settings/secrets/${provider}`, { method: 'DELETE' });
}

export function getMe() {
  return apiFetch<ResponseOf<'GET /api/me'>>('/api/me');
}

export function getGitHubCatalog() {
  return apiFetch<ResponseOf<'GET /api/github/catalog'>>('/api/github/catalog');
}

export function connectGitHub() {
  return apiFetch<ResponseOf<'POST /api/github/connect'>>('/api/github/connect', { method: 'POST' });
}

// ---- tickets ---------------------------------------------------------------

export function importTicket(url: string) {
  return apiFetch<ResponseOf<'POST /api/tickets/import'>>('/api/tickets/import', { method: 'POST', json: { url } });
}
