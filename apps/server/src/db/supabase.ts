import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentResult,
  Artifact,
  Job,
  JobKind,
  JobPayload,
  JobStatus,
  Message,
  MessageRole,
  MessageSource,
  MergeMethod,
  PullRequest,
  PullRequestStatus,
  SecretProvider,
  Task,
  TaskEvent,
  TaskRepository,
  Worker,
  WorkerKey,
  WorkerStatus,
  Workflow,
  WorkflowRecord,
  GitHubFeedbackKind,
} from '@sindral/shared';
import { ARTIFACT_CONTENT_TYPES, MAX_ARTIFACT_BYTES } from '@sindral/shared';
import type { OperationalSnapshot } from '../metrics.js';
import {
  ConflictError,
  RepositoryError,
  type ActiveJob,
  type ArtifactInsert,
  type EventInsert,
  type JobInsert,
  type ClaimedJob,
  type JobOutcomeClaim,
  type JobLog,
  type JobLogInsert,
  type JobLogType,
  type JobPatch,
  type MessageInsert,
  type Profile,
  type Repository,
  type SecretUpsert,
  type StoredSecret,
  type TaskFilter,
  type TaskInsert,
  type TaskPatch,
  type TaskRepositoryUpsert,
  type TaskTransitionCommand,
  type TaskTransitionResult,
  type PullRequestUpsert,
  type WorkerInsert,
  type WorkerKeyInsert,
  type WorkerKeyLookup,
  type WorkerPatch,
  type WorkflowInsert,
  type WorkflowPatch,
  type WebhookDeliveryClaim,
  type WebhookDeliveryResponse,
} from './repository.js';

export function createSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export const EXPECTED_SCHEMA_VERSION = '20260926000000';

// ---- row shapes (snake_case, as stored) ----
interface ProfileRow {
  id: string;
  display_name: string | null;
  github_username: string | null;
}
interface WorkflowRow {
  id: string;
  user_id: string;
  name: string;
  definition: Workflow;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
interface TaskRow {
  id: string;
  user_id: string;
  version: number;
  key: string;
  title: string;
  description: string;
  outcome: string;
  acceptance_criteria: string;
  state: string;
  current_step_id: string | null;
  workflow_id: string | null;
  pinned_workflow: Workflow | null;
  repos: string[];
  ticket_url: string | null;
  pr_url: string | null;
  branch: string | null;
  base_branch: string | null;
  plan: string | null;
  parent_task_id: string | null;
  sequence: number | null;
  failed_step_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
interface TaskRepositoryRow {
  id: string;
  user_id: string;
  task_id: string;
  repository: string;
  branch: string;
  base_branch: string | null;
  merge_method: MergeMethod;
  created_at: string;
  updated_at: string;
}
interface PullRequestRow {
  id: string;
  user_id: string;
  task_id: string;
  task_repository_id: string;
  repository: string;
  url: string;
  number: number;
  branch: string;
  base_branch: string;
  head_sha: string | null;
  status: PullRequestStatus;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}
interface MessageRow {
  id: string;
  task_id: string;
  role: MessageRole;
  source: MessageSource;
  content: string;
  external_id: string | null;
  github_feedback_kind: GitHubFeedbackKind | null;
  github_comment_url: string | null;
  github_pr_url: string | null;
  created_at: string;
}
interface EventRow {
  id: string;
  task_id: string;
  type: string;
  from_state: string | null;
  to_state: string | null;
  step_id: string | null;
  detail: Record<string, unknown> | null;
  dedupe_key?: string | null;
  created_at: string;
}
interface ArtifactRow {
  id: string;
  task_id: string;
  job_id: string | null;
  name: string;
  content_type: string;
  content: string | null;
  storage_path: string | null;
  byte_size: number;
  dedupe_key?: string | null;
  created_at: string;
}
interface JobRow {
  id: string;
  user_id: string;
  task_id: string;
  kind: JobKind;
  step_id: string | null;
  status: JobStatus;
  worker_id: string | null;
  attempt: number;
  payload: JobPayload;
  result: AgentResult | null;
  error: string | null;
  outcome_hash: string | null;
  outcome_token: string | null;
  outcome_started_at: string | null;
  dedupe_key: string | null;
  created_at: string;
  claimed_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  finished_at: string | null;
}
interface JobLogRow {
  id: number;
  job_id: string;
  type: JobLogType;
  message: string;
  created_at: string;
}
interface WorkerRow {
  id: string;
  user_id: string;
  name: string;
  hostname: string;
  version: string;
  status: WorkerStatus;
  running_jobs: number;
  last_seen_at: string;
  created_at: string;
}
interface WorkerKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface SecretRow {
  user_id: string;
  provider: SecretProvider;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  hint: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const UNIQUE_VIOLATION = '23505';

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

async function run<T>(query: PromiseLike<QueryResult>): Promise<T> {
  const { data, error } = await query;
  if (error) {
    if (error.code === UNIQUE_VIOLATION) throw new ConflictError(error.message);
    throw new RepositoryError(error.message, error.code);
  }
  return data as T;
}

const mapWorkflow = (r: WorkflowRow): WorkflowRecord => ({
  ...r.definition,
  id: r.id,
  name: r.name,
  userId: r.user_id,
  isDefault: r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapTask = (r: TaskRow): Task => ({
  id: r.id,
  userId: r.user_id,
  version: Number(r.version),
  key: r.key,
  title: r.title,
  description: r.description,
  outcome: r.outcome,
  acceptanceCriteria: r.acceptance_criteria,
  state: r.state,
  currentStepId: r.current_step_id,
  workflowId: r.workflow_id,
  pinnedWorkflow: r.pinned_workflow,
  repos: r.repos ?? [],
  ticketUrl: r.ticket_url,
  prUrl: r.pr_url,
  branch: r.branch,
  baseBranch: r.base_branch,
  plan: r.plan,
  parentTaskId: r.parent_task_id,
  sequence: r.sequence,
  failedStepId: r.failed_step_id,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapTaskRepository = (r: TaskRepositoryRow): TaskRepository => ({
  id: r.id,
  userId: r.user_id,
  taskId: r.task_id,
  repository: r.repository,
  branch: r.branch,
  baseBranch: r.base_branch,
  mergeMethod: r.merge_method,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapPullRequest = (r: PullRequestRow): PullRequest => ({
  id: r.id,
  userId: r.user_id,
  taskId: r.task_id,
  taskRepositoryId: r.task_repository_id,
  repository: r.repository,
  url: r.url,
  number: r.number,
  branch: r.branch,
  baseBranch: r.base_branch,
  headSha: r.head_sha,
  status: r.status,
  mergedAt: r.merged_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMessage = (r: MessageRow): Message => ({
  id: r.id,
  taskId: r.task_id,
  role: r.role,
  content: r.content,
  source: r.source,
  externalId: r.external_id,
  githubFeedback:
    r.github_feedback_kind && r.external_id && r.github_pr_url
      ? { kind: r.github_feedback_kind, commentId: r.external_id, commentUrl: r.github_comment_url, prUrl: r.github_pr_url }
      : null,
  createdAt: r.created_at,
});

const mapEvent = (r: EventRow): TaskEvent => ({
  id: r.id,
  taskId: r.task_id,
  type: r.type,
  fromState: r.from_state,
  toState: r.to_state,
  stepId: r.step_id,
  detail: r.detail,
  createdAt: r.created_at,
});

const mapArtifact = (r: ArtifactRow, downloadUrl: string | null = null): Artifact => ({
  id: r.id,
  taskId: r.task_id,
  jobId: r.job_id,
  name: r.name,
  contentType: r.content_type,
  content: r.content,
  byteSize: Number(r.byte_size),
  downloadUrl,
  createdAt: r.created_at,
});

const mapJob = (r: JobRow): Job => ({
  id: r.id,
  userId: r.user_id,
  taskId: r.task_id,
  kind: r.kind,
  stepId: r.step_id,
  status: r.status,
  workerId: r.worker_id,
  attempt: r.attempt,
  payload: r.payload,
  result: r.result,
  error: r.error,
  outcomeHash: r.outcome_hash,
  outcomeToken: r.outcome_token,
  outcomeStartedAt: r.outcome_started_at,
  dedupeKey: r.dedupe_key,
  createdAt: r.created_at,
  claimedAt: r.claimed_at,
  leaseExpiresAt: r.lease_expires_at,
  finishedAt: r.finished_at,
});

const mapClaimedJob = (r: JobRow): ClaimedJob => {
  if (!r.lease_token || !r.lease_expires_at) throw new RepositoryError('Claimed job is missing its lease capability');
  return { ...mapJob(r), leaseToken: r.lease_token };
};

const mapJobLog = (r: JobLogRow): JobLog => ({ id: r.id, jobId: r.job_id, type: r.type, message: r.message, createdAt: r.created_at });

const mapWorker = (r: WorkerRow): Worker => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  hostname: r.hostname,
  version: r.version,
  status: r.status,
  runningJobs: r.running_jobs,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});

const mapWorkerKey = (r: WorkerKeyRow): WorkerKey => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  keyPrefix: r.key_prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

const mapSecret = (r: SecretRow): StoredSecret => ({
  userId: r.user_id,
  provider: r.provider,
  ciphertext: r.ciphertext,
  iv: r.iv,
  authTag: r.auth_tag,
  hint: r.hint,
  metadata: r.metadata ?? {},
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function taskPatchToRow(patch: TaskPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.outcome !== undefined) row.outcome = patch.outcome;
  if (patch.acceptanceCriteria !== undefined) row.acceptance_criteria = patch.acceptanceCriteria;
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.currentStepId !== undefined) row.current_step_id = patch.currentStepId;
  if (patch.workflowId !== undefined) row.workflow_id = patch.workflowId;
  if (patch.pinnedWorkflow !== undefined) row.pinned_workflow = patch.pinnedWorkflow;
  if (patch.repos !== undefined) row.repos = patch.repos;
  if (patch.prUrl !== undefined) row.pr_url = patch.prUrl;
  if (patch.branch !== undefined) row.branch = patch.branch;
  if (patch.baseBranch !== undefined) row.base_branch = patch.baseBranch;
  if (patch.plan !== undefined) row.plan = patch.plan;
  if (patch.failedStepId !== undefined) row.failed_step_id = patch.failedStepId;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  return row;
}

function jobPatchToRow(patch: JobPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.workerId !== undefined) row.worker_id = patch.workerId;
  if (patch.attempt !== undefined) row.attempt = patch.attempt;
  if (patch.result !== undefined) row.result = patch.result;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.claimedAt !== undefined) row.claimed_at = patch.claimedAt;
  if (patch.leaseExpiresAt !== undefined) row.lease_expires_at = patch.leaseExpiresAt;
  if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
  if (patch.status === 'queued') row.lease_token = null;
  return row;
}

function workerPatchToRow(patch: WorkerPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.hostname !== undefined) row.hostname = patch.hostname;
  if (patch.version !== undefined) row.version = patch.version;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.runningJobs !== undefined) row.running_jobs = patch.runningJobs;
  if (patch.lastSeenAt !== undefined) row.last_seen_at = patch.lastSeenAt;
  return row;
}

/** Repository backed by Supabase Postgres via the service-role client. Every query is additionally scoped by user id. */
export class SupabaseRepository implements Repository {
  private artifactBucketReady: Promise<void> | null = null;

  constructor(private readonly client: SupabaseClient) {}

  async getOperationalSnapshot(): Promise<OperationalSnapshot> {
    const snapshot = await run<{
      taskStates?: Record<string, number>;
      jobStatuses?: Record<string, number>;
      workerCount?: number;
      oldestWorkerHeartbeatAgeSeconds?: number;
    }>(this.client.rpc('sindral_operational_snapshot'));
    return {
      taskStates: snapshot.taskStates ?? {},
      jobStatuses: snapshot.jobStatuses ?? {},
      workerCount: Number(snapshot.workerCount ?? 0),
      oldestWorkerHeartbeatAgeSeconds: Number(snapshot.oldestWorkerHeartbeatAgeSeconds ?? 0),
    };
  }

  /** Fail startup before listening when Postgres is unreachable or migrations lag the server. */
  async assertCompatibleSchema(): Promise<void> {
    const version = await run<string>(this.client.rpc('sindral_schema_version'));
    if (version !== EXPECTED_SCHEMA_VERSION) {
      throw new RepositoryError(`Database schema ${version || 'unknown'} is incompatible; expected ${EXPECTED_SCHEMA_VERSION}. Apply all Supabase migrations before starting the server.`);
    }
  }

  private ensureArtifactBucket(): Promise<void> {
    if (this.artifactBucketReady) return this.artifactBucketReady;
    this.artifactBucketReady = (async () => {
      const buckets = this.client.storage;
      const existing = await buckets.getBucket('task-artifacts');
      const options = { public: false, fileSizeLimit: MAX_ARTIFACT_BYTES, allowedMimeTypes: [...ARTIFACT_CONTENT_TYPES] };
      if (existing.data) {
        const { error } = await buckets.updateBucket('task-artifacts', options);
        if (error) throw new RepositoryError(`Could not secure artifact storage: ${error.message}`);
        return;
      }
      const created = await buckets.createBucket('task-artifacts', options);
      if (created.error) {
        // Another server instance may have won the create race. Re-read before failing.
        const raced = await buckets.getBucket('task-artifacts');
        if (!raced.data) throw new RepositoryError(`Could not create artifact storage: ${created.error.message}`);
        const { error } = await buckets.updateBucket('task-artifacts', options);
        if (error) throw new RepositoryError(`Could not secure artifact storage: ${error.message}`);
      }
    })().catch((error: unknown) => {
      this.artifactBucketReady = null;
      throw error;
    });
    return this.artifactBucketReady;
  }

  private async hydrateArtifact(row: ArtifactRow): Promise<Artifact> {
    if (!row.storage_path) return mapArtifact(row);
    await this.ensureArtifactBucket();
    const { data, error } = await this.client.storage.from('task-artifacts').createSignedUrl(row.storage_path, 15 * 60, { download: row.name });
    if (error || !data?.signedUrl) throw new RepositoryError(`Could not authorize artifact download: ${error?.message ?? 'missing signed URL'}`);
    return mapArtifact(row, data.signedUrl);
  }

  private async drainArtifactDeletions(userId: string): Promise<void> {
    let bucketReady = false;
    while (true) {
      const rows = await run<{ storage_path: string }[]>(
        this.client.from('artifact_storage_deletions').select('storage_path').eq('user_id', userId).order('created_at').limit(100),
      );
      if (rows.length === 0) return;
      if (!bucketReady) {
        await this.ensureArtifactBucket();
        bucketReady = true;
      }
      const paths = rows.map((row) => row.storage_path);
      const { error } = await this.client.storage.from('task-artifacts').remove(paths);
      if (error) throw new RepositoryError(`Could not remove deleted artifacts: ${error.message}`);
      await run(this.client.from('artifact_storage_deletions').delete().eq('user_id', userId).in('storage_path', paths));
    }
  }

  // ---- profiles ----
  async ensureProfile(userId: string, displayNameHint: string | null): Promise<Profile> {
    const existing = await run<ProfileRow | null>(
      this.client.from('profiles').select('id, display_name, github_username').eq('id', userId).maybeSingle(),
    );
    if (existing) return { id: existing.id, displayName: existing.display_name, githubUsername: existing.github_username };
    await run(this.client.from('profiles').upsert({ id: userId, display_name: displayNameHint }, { onConflict: 'id', ignoreDuplicates: true }));
    const created = await run<ProfileRow | null>(
      this.client.from('profiles').select('id, display_name, github_username').eq('id', userId).maybeSingle(),
    );
    return { id: userId, displayName: created?.display_name ?? displayNameHint, githubUsername: created?.github_username ?? null };
  }

  async nextTaskNumber(userId: string): Promise<number> {
    const n = await run<number>(this.client.rpc('next_task_number', { p_user_id: userId }));
    return Number(n);
  }

  // ---- workflows ----
  async listWorkflows(userId: string): Promise<WorkflowRecord[]> {
    const rows = await run<WorkflowRow[]>(this.client.from('workflows').select('*').eq('user_id', userId).order('created_at', { ascending: true }));
    return rows.map(mapWorkflow);
  }

  async getWorkflow(userId: string, id: string): Promise<WorkflowRecord | null> {
    const row = await run<WorkflowRow | null>(this.client.from('workflows').select('*').eq('user_id', userId).eq('id', id).maybeSingle());
    return row ? mapWorkflow(row) : null;
  }

  async createWorkflow(userId: string, input: WorkflowInsert): Promise<WorkflowRecord> {
    const row = await run<WorkflowRow>(
      this.client
        .from('workflows')
        .insert({ id: input.id, user_id: userId, name: input.definition.name, definition: { ...input.definition, id: input.id }, is_default: input.isDefault })
        .select('*')
        .single(),
    );
    return mapWorkflow(row);
  }

  async updateWorkflow(userId: string, id: string, patch: WorkflowPatch): Promise<WorkflowRecord | null> {
    const update: Record<string, unknown> = {};
    if (patch.definition) {
      update.definition = { ...patch.definition, id };
      update.name = patch.definition.name;
    }
    if (patch.isDefault !== undefined) update.is_default = patch.isDefault;
    const row = await run<WorkflowRow | null>(
      this.client.from('workflows').update(update).eq('user_id', userId).eq('id', id).select('*').maybeSingle(),
    );
    return row ? mapWorkflow(row) : null;
  }

  async deleteWorkflow(userId: string, id: string): Promise<boolean> {
    const rows = await run<{ id: string }[]>(this.client.from('workflows').delete().eq('user_id', userId).eq('id', id).select('id'));
    return rows.length > 0;
  }

  // ---- tasks ----
  async createTask(userId: string, input: TaskInsert): Promise<Task> {
    const row = await run<TaskRow>(
      this.client
        .from('tasks')
        .insert({
          user_id: userId,
          key: input.key,
          title: input.title,
          description: input.description,
          outcome: input.outcome,
          acceptance_criteria: input.acceptanceCriteria,
          state: input.state,
          current_step_id: input.currentStepId,
          workflow_id: input.workflowId,
          pinned_workflow: input.pinnedWorkflow,
          repos: input.repos,
          ticket_url: input.ticketUrl,
          branch: input.branch,
          base_branch: input.baseBranch,
          parent_task_id: input.parentTaskId,
          sequence: input.sequence,
        })
        .select('*')
        .single(),
    );
    return mapTask(row);
  }

  async getTask(userId: string, id: string): Promise<Task | null> {
    const row = await run<TaskRow | null>(this.client.from('tasks').select('*').eq('user_id', userId).eq('id', id).maybeSingle());
    return row ? mapTask(row) : null;
  }

  async listTasks(userId: string, filter: TaskFilter): Promise<Task[]> {
    let query = this.client.from('tasks').select('*').eq('user_id', userId);
    if (filter.parentTaskId) query = query.eq('parent_task_id', filter.parentTaskId);
    else if (!filter.includeSubtasks) query = query.is('parent_task_id', null);
    if (filter.state) query = query.eq('state', filter.state);
    if (filter.workflowId) query = query.eq('workflow_id', filter.workflowId);
    const rows = await run<TaskRow[]>(query.order('created_at', { ascending: false }));
    // Search is applied in memory to avoid building PostgREST filter strings from user input.
    const search = filter.search?.trim().toLowerCase();
    return rows.map(mapTask).filter((t) => !search || t.title.toLowerCase().includes(search) || t.key.toLowerCase().includes(search));
  }

  async listSubtasks(userId: string, parentTaskId: string): Promise<Task[]> {
    const rows = await run<TaskRow[]>(
      this.client.from('tasks').select('*').eq('user_id', userId).eq('parent_task_id', parentTaskId).order('sequence', { ascending: true }),
    );
    return rows.map(mapTask);
  }

  async updateTask(userId: string, id: string, patch: TaskPatch): Promise<Task | null> {
    const row = await run<TaskRow | null>(
      this.client.from('tasks').update(taskPatchToRow(patch)).eq('user_id', userId).eq('id', id).select('*').maybeSingle(),
    );
    return row ? mapTask(row) : null;
  }

  async getTaskTransitionReplay(userId: string, idempotencyKey: string, requestHash: string): Promise<TaskTransitionResult | null> {
    const row = await run<{ request_hash: string; response: { task: TaskRow; job: JobRow | null; replayed: boolean } | null } | null>(
      this.client
        .from('idempotency_keys')
        .select('request_hash,response')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .eq('operation', 'task-transition')
        .maybeSingle(),
    );
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new ConflictError('Idempotency key was already used for a different request');
    if (!row.response) throw new ConflictError('Idempotent command is still in progress');
    return {
      task: mapTask(row.response.task),
      job: row.response.job ? mapJob(row.response.job) : null,
      replayed: true,
    };
  }

  async getTaskTransitionReplayByKey(userId: string, idempotencyKey: string): Promise<TaskTransitionResult | null> {
    const row = await run<{ response: { task: TaskRow; job: JobRow | null; replayed: boolean } | null } | null>(
      this.client
        .from('idempotency_keys')
        .select('response')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .eq('operation', 'task-transition')
        .maybeSingle(),
    );
    if (!row) return null;
    if (!row.response) throw new ConflictError('Idempotent command is still in progress');
    return { task: mapTask(row.response.task), job: row.response.job ? mapJob(row.response.job) : null, replayed: true };
  }

  async applyTaskTransition(userId: string, command: TaskTransitionCommand): Promise<TaskTransitionResult> {
    const event = command.event;
    const job = command.job;
    try {
      const response = await run<{ task: TaskRow; job: JobRow | null; replayed: boolean }>(
        this.client.rpc('apply_task_transition', {
          p_user_id: userId,
          p_task_id: command.taskId,
          p_expected_version: command.expectedVersion,
          p_idempotency_key: command.idempotencyKey,
          p_request_hash: command.requestHash,
          p_next_state: command.patch.state,
          p_next_step_id: command.patch.currentStepId,
          p_failed_step_id: command.patch.failedStepId,
          p_pin_workflow: command.patch.pinnedWorkflow !== undefined,
          p_pinned_workflow: command.patch.pinnedWorkflow ?? null,
          p_event: {
            type: event.type,
            fromState: event.fromState ?? null,
            toState: event.toState ?? null,
            stepId: event.stepId ?? null,
            detail: event.detail ?? null,
          },
          p_job: job ? { kind: job.kind, stepId: job.stepId, payload: job.payload } : null,
          p_cancel_queued: command.cancelQueuedJobs ?? false,
        }),
      );
      return { task: mapTask(response.task), job: response.job ? mapJob(response.job) : null, replayed: response.replayed };
    } catch (error) {
      if (error instanceof RepositoryError && (error.code === '40001' || error.code === '22023' || error.code === '42501')) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  }

  async deleteTask(userId: string, id: string): Promise<boolean> {
    const rows = await run<{ id: string }[]>(this.client.from('tasks').delete().eq('user_id', userId).eq('id', id).select('id'));
    if (rows.length > 0) await this.drainArtifactDeletions(userId);
    return rows.length > 0;
  }

  async findTaskByPrUrl(prUrl: string): Promise<Task | null> {
    const pullRequest = await this.findPullRequestByUrl(prUrl);
    if (pullRequest) return this.getTask(pullRequest.userId, pullRequest.taskId);
    const row = await run<TaskRow | null>(this.client.from('tasks').select('*').eq('pr_url', prUrl).limit(1).maybeSingle());
    return row ? mapTask(row) : null;
  }

  // ---- task repositories and pull requests ----
  async listTaskRepositories(userId: string, taskId: string): Promise<TaskRepository[]> {
    const rows = await run<TaskRepositoryRow[]>(
      this.client.from('task_repositories').select('*').eq('user_id', userId).eq('task_id', taskId).order('created_at', { ascending: true }),
    );
    return rows.map(mapTaskRepository);
  }

  async upsertTaskRepository(userId: string, taskId: string, input: TaskRepositoryUpsert): Promise<TaskRepository> {
    const row = await run<TaskRepositoryRow>(
      this.client
        .from('task_repositories')
        .upsert(
          {
            user_id: userId,
            task_id: taskId,
            repository: input.repository,
            branch: input.branch,
            base_branch: input.baseBranch,
            merge_method: input.mergeMethod ?? 'squash',
          },
          { onConflict: 'task_id,repository' },
        )
        .select('*')
        .single(),
    );
    return mapTaskRepository(row);
  }

  async deleteTaskRepositoriesNotIn(userId: string, taskId: string, repositories: string[]): Promise<void> {
    const keep = new Set(repositories);
    const existing = await this.listTaskRepositories(userId, taskId);
    const ids = existing.filter((record) => !keep.has(record.repository)).map((record) => record.id);
    if (ids.length > 0) await run(this.client.from('task_repositories').delete().eq('user_id', userId).eq('task_id', taskId).in('id', ids));
  }

  async listPullRequests(userId: string, taskId: string): Promise<PullRequest[]> {
    const rows = await run<PullRequestRow[]>(
      this.client.from('pull_requests').select('*').eq('user_id', userId).eq('task_id', taskId).order('created_at', { ascending: true }),
    );
    return rows.map(mapPullRequest);
  }

  async upsertPullRequest(userId: string, taskId: string, input: PullRequestUpsert): Promise<PullRequest> {
    const row = await run<PullRequestRow>(
      this.client
        .from('pull_requests')
        .upsert(
          {
            user_id: userId,
            task_id: taskId,
            task_repository_id: input.taskRepositoryId,
            repository: input.repository,
            url: input.url,
            number: input.number,
            branch: input.branch,
            base_branch: input.baseBranch,
            head_sha: input.headSha,
            status: input.status ?? 'open',
            merged_at: input.mergedAt ?? null,
          },
          { onConflict: 'task_id,repository' },
        )
        .select('*')
        .single(),
    );
    return mapPullRequest(row);
  }

  async findPullRequestByUrl(prUrl: string): Promise<PullRequest | null> {
    const row = await run<PullRequestRow | null>(this.client.from('pull_requests').select('*').eq('url', prUrl).limit(1).maybeSingle());
    return row ? mapPullRequest(row) : null;
  }

  // ---- messages ----
  async listMessages(userId: string, taskId: string): Promise<Message[]> {
    const rows = await run<MessageRow[]>(
      this.client.from('task_messages').select('*').eq('user_id', userId).eq('task_id', taskId).order('created_at', { ascending: true }),
    );
    return rows.map(mapMessage);
  }

  async createMessage(userId: string, input: MessageInsert): Promise<Message | null> {
    try {
      const row = await run<MessageRow>(
        this.client
          .from('task_messages')
          .insert({
            task_id: input.taskId,
            user_id: userId,
            role: input.role,
            source: input.source,
            content: input.content,
            external_id: input.externalId ?? null,
            github_feedback_kind: input.githubFeedback?.kind ?? null,
            github_comment_url: input.githubFeedback?.commentUrl ?? null,
            github_pr_url: input.githubFeedback?.prUrl ?? null,
          })
          .select('*')
          .single(),
      );
      return mapMessage(row);
    } catch (err) {
      if (err instanceof ConflictError && input.externalId) return null;
      throw err;
    }
  }

  async beginWebhookDelivery(deliveryId: string, eventName: string, payloadHash: string): Promise<WebhookDeliveryClaim> {
    try {
      return await run<WebhookDeliveryClaim>(
        this.client.rpc('begin_webhook_delivery', { p_delivery_id: deliveryId, p_event_name: eventName, p_payload_hash: payloadHash }),
      );
    } catch (error) {
      if (error instanceof RepositoryError && ['22023', '40001'].includes(error.code ?? '')) throw new ConflictError(error.message);
      throw error;
    }
  }

  async finalizeWebhookDelivery(deliveryId: string, payloadHash: string, token: string, response: WebhookDeliveryResponse): Promise<void> {
    await run(
      this.client.rpc('finalize_webhook_delivery', {
        p_delivery_id: deliveryId,
        p_payload_hash: payloadHash,
        p_token: token,
        p_response: response,
      }),
    );
  }

  async abandonWebhookDelivery(deliveryId: string, payloadHash: string, token: string): Promise<void> {
    await run(this.client.rpc('abandon_webhook_delivery', { p_delivery_id: deliveryId, p_payload_hash: payloadHash, p_token: token }));
  }

  // ---- events ----
  async listEvents(userId: string, taskId: string): Promise<TaskEvent[]> {
    const rows = await run<EventRow[]>(
      this.client.from('task_events').select('*').eq('user_id', userId).eq('task_id', taskId).order('created_at', { ascending: true }),
    );
    return rows.map(mapEvent);
  }

  async createEvent(userId: string, input: EventInsert): Promise<TaskEvent> {
    const row = await run<EventRow | null>(
      this.client
        .from('task_events')
        .upsert(
          {
            task_id: input.taskId,
            user_id: userId,
            type: input.type,
            from_state: input.fromState ?? null,
            to_state: input.toState ?? null,
            step_id: input.stepId ?? null,
            detail: input.detail ?? null,
            dedupe_key: input.dedupeKey ?? null,
          },
          input.dedupeKey ? { onConflict: 'task_id,dedupe_key', ignoreDuplicates: true } : undefined,
        )
        .select('*')
        .maybeSingle(),
    );
    if (row) return mapEvent(row);
    const existing = await run<EventRow>(
      this.client.from('task_events').select('*').eq('user_id', userId).eq('task_id', input.taskId).eq('dedupe_key', input.dedupeKey!).single(),
    );
    return mapEvent(existing);
  }

  // ---- artifacts ----
  async listArtifacts(userId: string, taskId: string): Promise<Artifact[]> {
    const rows = await run<ArtifactRow[]>(
      this.client.from('task_artifacts').select('*').eq('user_id', userId).eq('task_id', taskId).order('created_at', { ascending: true }),
    );
    return Promise.all(rows.map((row) => this.hydrateArtifact(row)));
  }

  async createArtifact(userId: string, input: ArtifactInsert): Promise<Artifact> {
    if (input.dedupeKey) {
      const existing = await run<ArtifactRow | null>(
        this.client.from('task_artifacts').select('*').eq('user_id', userId).eq('task_id', input.taskId).eq('dedupe_key', input.dedupeKey).maybeSingle(),
      );
      if (existing) return this.hydrateArtifact(existing);
    }

    if (!ARTIFACT_CONTENT_TYPES.includes(input.contentType as (typeof ARTIFACT_CONTENT_TYPES)[number])) {
      throw new RepositoryError(`Unsupported artifact content type: ${input.contentType}`, '22023');
    }
    const byteSize = Buffer.byteLength(input.content, 'utf8');
    if (byteSize > MAX_ARTIFACT_BYTES) throw new RepositoryError(`Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte limit`, '22001');
    const stored = byteSize > 64 * 1024;
    const storagePath = stored
      ? `${userId}/${input.taskId}/${createHash('sha256').update(input.dedupeKey ?? '').update('\0').update(input.name).update('\0').update(input.contentType).update('\0').update(input.content).digest('hex')}`
      : null;

    if (storagePath) {
      await this.ensureArtifactBucket();
      await this.drainArtifactDeletions(userId);
      const { error } = await this.client.storage.from('task-artifacts').upload(storagePath, Buffer.from(input.content, 'utf8'), {
        contentType: input.contentType,
        upsert: false,
      });
      const conflict = error && (String(error.statusCode) === '409' || /already exists/i.test(error.message));
      if (error && !conflict) throw new RepositoryError(`Could not store artifact: ${error.message}`);
    }

    const row = await run<ArtifactRow>(
      this.client
        .from('task_artifacts')
        .upsert(
          {
            task_id: input.taskId,
            user_id: userId,
            job_id: input.jobId ?? null,
            name: input.name,
            content_type: input.contentType,
            content: stored ? null : input.content,
            storage_path: storagePath,
            byte_size: byteSize,
            dedupe_key: input.dedupeKey ?? null,
          },
          input.dedupeKey ? { onConflict: 'task_id,dedupe_key', ignoreDuplicates: true } : undefined,
        )
        .select('*')
        .maybeSingle(),
    );
    if (row) return this.hydrateArtifact(row);
    const existing = await run<ArtifactRow>(
      this.client.from('task_artifacts').select('*').eq('user_id', userId).eq('task_id', input.taskId).eq('dedupe_key', input.dedupeKey!).single(),
    );
    return this.hydrateArtifact(existing);
  }

  // ---- jobs ----
  async createJob(userId: string, input: JobInsert): Promise<Job> {
    const row = await run<JobRow>(
      this.client
        .from('jobs')
        .upsert(
          { user_id: userId, task_id: input.taskId, kind: input.kind, step_id: input.stepId, payload: input.payload, dedupe_key: input.dedupeKey ?? null },
          input.dedupeKey ? { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true } : undefined,
        )
        .select('*')
        .maybeSingle(),
    );
    if (row) return mapJob(row);
    const existing = await run<JobRow>(this.client.from('jobs').select('*').eq('user_id', userId).eq('dedupe_key', input.dedupeKey!).single());
    return mapJob(existing);
  }

  async beginJobOutcome(
    userId: string,
    jobId: string,
    attempt: number,
    outcomeHash: string,
    outcome: { result: AgentResult; error?: never } | { error: string; result?: never },
    leaseToken: string,
  ): Promise<JobOutcomeClaim> {
    try {
      const response = await run<{ state: JobOutcomeClaim['state']; token: string | null; job: JobRow }>(
        this.client.rpc('begin_job_outcome', {
          p_user_id: userId,
          p_job_id: jobId,
          p_attempt: attempt,
          p_lease_token: leaseToken,
          p_outcome_hash: outcomeHash,
          p_result: outcome.result ?? null,
          p_error: outcome.error ?? null,
        }),
      );
      return { state: response.state, token: response.token, job: mapJob(response.job) };
    } catch (error) {
      if (error instanceof RepositoryError && ['22023', '40001', '42501'].includes(error.code ?? '')) throw new ConflictError(error.message);
      throw error;
    }
  }

  async finalizeJobOutcome(
    userId: string,
    jobId: string,
    attempt: number,
    outcomeHash: string,
    token: string,
    status: 'completed' | 'failed',
  ): Promise<Job> {
    try {
      const row = await run<JobRow>(
        this.client.rpc('finalize_job_outcome', {
          p_user_id: userId,
          p_job_id: jobId,
          p_attempt: attempt,
          p_outcome_hash: outcomeHash,
          p_token: token,
          p_status: status,
        }),
      );
      return mapJob(row);
    } catch (error) {
      if (error instanceof RepositoryError && ['22023', '40001', '42501'].includes(error.code ?? '')) throw new ConflictError(error.message);
      throw error;
    }
  }

  async abandonJobOutcome(userId: string, jobId: string, attempt: number, outcomeHash: string, token: string): Promise<void> {
    await run(this.client.rpc('abandon_job_outcome', { p_user_id: userId, p_job_id: jobId, p_attempt: attempt, p_outcome_hash: outcomeHash, p_token: token }));
  }

  async getJob(userId: string, id: string): Promise<Job | null> {
    const row = await run<JobRow | null>(this.client.from('jobs').select('*').eq('user_id', userId).eq('id', id).maybeSingle());
    return row ? mapJob(row) : null;
  }

  async listJobsForTask(userId: string, taskId: string): Promise<Job[]> {
    const rows = await run<JobRow[]>(
      this.client.from('jobs').select('*').eq('user_id', userId).eq('task_id', taskId).order('created_at', { ascending: true }),
    );
    return rows.map(mapJob);
  }

  async updateJob(userId: string, id: string, patch: JobPatch): Promise<Job | null> {
    const row = await run<JobRow | null>(this.client.from('jobs').update(jobPatchToRow(patch)).eq('user_id', userId).eq('id', id).select('*').maybeSingle());
    return row ? mapJob(row) : null;
  }

  async claimJobs(userId: string, workerId: string, max: number, allowedKinds?: JobKind[]): Promise<ClaimedJob[]> {
    const rows = await run<JobRow[]>(this.client.rpc('claim_jobs', {
      p_user_id: userId,
      p_worker_id: workerId,
      p_max: max,
      p_allowed_kinds: allowedKinds ?? null,
    }));
    return rows.map(mapClaimedJob);
  }

  async renewJobLeases(userId: string, workerId: string, jobs: { jobId: string; leaseToken: string }[]): Promise<number> {
    if (jobs.length === 0) return 0;
    return Number(await run<number>(this.client.rpc('renew_job_leases', { p_user_id: userId, p_worker_id: workerId, p_leases: jobs })));
  }

  async activateJobLease(userId: string, jobId: string, attempt: number, leaseToken: string): Promise<boolean> {
    return Boolean(await run<boolean>(this.client.rpc('activate_job_lease', {
      p_user_id: userId,
      p_job_id: jobId,
      p_attempt: attempt,
      p_lease_token: leaseToken,
    })));
  }

  async cancelQueuedJobs(userId: string, taskId: string): Promise<number> {
    const rows = await run<{ id: string }[]>(
      this.client
        .from('jobs')
        .update({ status: 'cancelled', finished_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('task_id', taskId)
        .eq('status', 'queued')
        .select('id'),
    );
    return rows.length;
  }

  async listActiveJobs(): Promise<ActiveJob[]> {
    const rows = await run<JobRow[]>(this.client.from('jobs').select('*').in('status', ['claimed', 'running', 'applying']));
    return rows.map((row) => ({ ...mapJob(row), leaseToken: row.lease_token }));
  }

  async listActiveJobsForWorker(userId: string, workerId: string): Promise<ActiveJob[]> {
    const rows = await run<JobRow[]>(
      this.client.from('jobs').select('*').eq('user_id', userId).eq('worker_id', workerId).in('status', ['claimed', 'running', 'applying']),
    );
    return rows.map((row) => ({ ...mapJob(row), leaseToken: row.lease_token }));
  }

  // ---- job logs ----
  async appendJobLog(userId: string, input: JobLogInsert): Promise<JobLog> {
    const row = await run<JobLogRow>(
      this.client.from('job_logs').insert({ job_id: input.jobId, user_id: userId, type: input.type, message: input.message }).select('*').single(),
    );
    return mapJobLog(row);
  }

  async listJobLogs(userId: string, jobId: string): Promise<JobLog[]> {
    const rows = await run<JobLogRow[]>(this.client.from('job_logs').select('*').eq('user_id', userId).eq('job_id', jobId).order('id', { ascending: true }));
    return rows.map(mapJobLog);
  }

  // ---- workers ----
  async listWorkers(userId: string): Promise<Worker[]> {
    const rows = await run<WorkerRow[]>(this.client.from('workers').select('*').eq('user_id', userId).order('created_at', { ascending: true }));
    return rows.map(mapWorker);
  }

  async getWorker(userId: string, id: string): Promise<Worker | null> {
    const row = await run<WorkerRow | null>(this.client.from('workers').select('*').eq('user_id', userId).eq('id', id).maybeSingle());
    return row ? mapWorker(row) : null;
  }

  async createWorker(userId: string, input: WorkerInsert): Promise<Worker> {
    const row = await run<WorkerRow>(
      this.client
        .from('workers')
        .insert({ user_id: userId, worker_key_id: input.workerKeyId, name: input.name, hostname: input.hostname, version: input.version })
        .select('*')
        .single(),
    );
    return mapWorker(row);
  }

  async updateWorker(userId: string, id: string, patch: WorkerPatch): Promise<Worker | null> {
    const row = await run<WorkerRow | null>(
      this.client.from('workers').update(workerPatchToRow(patch)).eq('user_id', userId).eq('id', id).select('*').maybeSingle(),
    );
    return row ? mapWorker(row) : null;
  }

  // ---- worker keys ----
  async listWorkerKeys(userId: string): Promise<WorkerKey[]> {
    const rows = await run<WorkerKeyRow[]>(this.client.from('worker_keys').select('*').eq('user_id', userId).order('created_at', { ascending: true }));
    return rows.map(mapWorkerKey);
  }

  async createWorkerKey(userId: string, input: WorkerKeyInsert): Promise<WorkerKey> {
    const row = await run<WorkerKeyRow>(
      this.client.from('worker_keys').insert({ user_id: userId, name: input.name, key_hash: input.keyHash, key_prefix: input.keyPrefix }).select('*').single(),
    );
    return mapWorkerKey(row);
  }

  async revokeWorkerKey(userId: string, id: string): Promise<boolean> {
    const rows = await run<{ id: string }[]>(
      this.client.from('worker_keys').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id).is('revoked_at', null).select('id'),
    );
    if (rows.length > 0) return true;
    const existing = await run<{ id: string } | null>(this.client.from('worker_keys').select('id').eq('user_id', userId).eq('id', id).maybeSingle());
    return existing !== null;
  }

  async findWorkerKeyByHash(keyHash: string): Promise<WorkerKeyLookup | null> {
    const row = await run<WorkerKeyRow | null>(this.client.from('worker_keys').select('*').eq('key_hash', keyHash).maybeSingle());
    return row ? { ...mapWorkerKey(row), keyHash: row.key_hash } : null;
  }

  async touchWorkerKey(userId: string, id: string, at: string): Promise<void> {
    await run(this.client.from('worker_keys').update({ last_used_at: at }).eq('user_id', userId).eq('id', id));
  }

  // ---- secrets ----
  async getSecret(userId: string, provider: SecretProvider): Promise<StoredSecret | null> {
    const row = await run<SecretRow | null>(this.client.from('user_secrets').select('*').eq('user_id', userId).eq('provider', provider).maybeSingle());
    return row ? mapSecret(row) : null;
  }

  async listSecrets(userId: string): Promise<StoredSecret[]> {
    const rows = await run<SecretRow[]>(this.client.from('user_secrets').select('*').eq('user_id', userId));
    return rows.map(mapSecret);
  }

  async upsertSecret(userId: string, provider: SecretProvider, input: SecretUpsert): Promise<StoredSecret> {
    const row = await run<SecretRow>(
      this.client
        .from('user_secrets')
        .upsert(
          { user_id: userId, provider, ciphertext: input.ciphertext, iv: input.iv, auth_tag: input.authTag, hint: input.hint, metadata: input.metadata },
          { onConflict: 'user_id,provider' },
        )
        .select('*')
        .single(),
    );
    return mapSecret(row);
  }

  async deleteSecret(userId: string, provider: SecretProvider): Promise<boolean> {
    const rows = await run<{ provider: string }[]>(
      this.client.from('user_secrets').delete().eq('user_id', userId).eq('provider', provider).select('provider'),
    );
    return rows.length > 0;
  }
}
