import type {
  Artifact,
  Job,
  JobKind,
  JobPayload,
  Message,
  MessageRole,
  MessageSource,
  SecretProvider,
  Task,
  TaskEvent,
  Worker,
  WorkerKey,
  Workflow,
  WorkflowRecord,
} from '@sindral/shared';

/** Raised when a unique constraint is violated (task key, message external id, ...). Mapped to 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export interface Profile {
  id: string;
  displayName: string | null;
  githubUsername: string | null;
}

export interface WorkflowInsert {
  /** Row id; must equal `definition.id`. */
  id: string;
  definition: Workflow;
  isDefault: boolean;
}

export interface WorkflowPatch {
  definition?: Workflow;
  isDefault?: boolean;
}

export interface TaskInsert {
  key: string;
  title: string;
  description: string;
  state: string;
  currentStepId: string | null;
  workflowId: string | null;
  pinnedWorkflow: Workflow | null;
  repos: string[];
  ticketUrl: string | null;
  branch: string | null;
  baseBranch: string | null;
  parentTaskId: string | null;
  sequence: number | null;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'state'
    | 'currentStepId'
    | 'workflowId'
    | 'pinnedWorkflow'
    | 'repos'
    | 'prUrl'
    | 'branch'
    | 'baseBranch'
    | 'plan'
    | 'failedStepId'
    | 'lastError'
  >
>;

export interface TaskFilter {
  state?: string;
  workflowId?: string;
  search?: string;
  parentTaskId?: string;
  includeSubtasks?: boolean;
}

export interface MessageInsert {
  taskId: string;
  role: MessageRole;
  content: string;
  source: MessageSource;
  externalId?: string | null;
}

export interface EventInsert {
  taskId: string;
  type: string;
  fromState?: string | null;
  toState?: string | null;
  stepId?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ArtifactInsert {
  taskId: string;
  jobId?: string | null;
  name: string;
  contentType: string;
  content: string;
}

export interface JobInsert {
  taskId: string;
  kind: JobKind;
  stepId: string | null;
  payload: JobPayload;
}

export type JobPatch = Partial<Pick<Job, 'status' | 'workerId' | 'attempt' | 'result' | 'error' | 'claimedAt' | 'finishedAt'>>;

export type JobLogType = 'log' | 'progress' | 'message';

export interface JobLog {
  id: number;
  jobId: string;
  type: JobLogType;
  message: string;
  createdAt: string;
}

export interface JobLogInsert {
  jobId: string;
  type: JobLogType;
  message: string;
}

export interface WorkerInsert {
  name: string;
  hostname: string;
  version: string;
  workerKeyId: string | null;
}

export type WorkerPatch = Partial<Pick<Worker, 'name' | 'hostname' | 'version' | 'status' | 'runningJobs' | 'lastSeenAt'>>;

export interface WorkerKeyInsert {
  name: string;
  keyHash: string;
  keyPrefix: string;
}

export interface WorkerKeyLookup extends WorkerKey {
  keyHash: string;
}

export interface StoredSecret {
  userId: string;
  provider: SecretProvider;
  ciphertext: string;
  iv: string;
  authTag: string;
  hint: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SecretUpsert {
  ciphertext: string;
  iv: string;
  authTag: string;
  hint: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Persistence boundary. Every method is scoped by the verified `userId`; the few
 * cross-user lookups are explicitly named so they stand out in review.
 */
export interface Repository {
  // profiles
  ensureProfile(userId: string, displayNameHint: string | null): Promise<Profile>;
  nextTaskNumber(userId: string): Promise<number>;

  // workflows
  listWorkflows(userId: string): Promise<WorkflowRecord[]>;
  getWorkflow(userId: string, id: string): Promise<WorkflowRecord | null>;
  createWorkflow(userId: string, input: WorkflowInsert): Promise<WorkflowRecord>;
  updateWorkflow(userId: string, id: string, patch: WorkflowPatch): Promise<WorkflowRecord | null>;
  deleteWorkflow(userId: string, id: string): Promise<boolean>;

  // tasks
  createTask(userId: string, input: TaskInsert): Promise<Task>;
  getTask(userId: string, id: string): Promise<Task | null>;
  listTasks(userId: string, filter: TaskFilter): Promise<Task[]>;
  listSubtasks(userId: string, parentTaskId: string): Promise<Task[]>;
  updateTask(userId: string, id: string, patch: TaskPatch): Promise<Task | null>;
  deleteTask(userId: string, id: string): Promise<boolean>;
  /** Cross-user: used by the GitHub webhook which carries no user context. */
  findTaskByPrUrl(prUrl: string): Promise<Task | null>;

  // messages
  listMessages(userId: string, taskId: string): Promise<Message[]>;
  /** Returns null when `externalId` already exists for the task (idempotent ingestion). */
  createMessage(userId: string, input: MessageInsert): Promise<Message | null>;

  // events
  listEvents(userId: string, taskId: string): Promise<TaskEvent[]>;
  createEvent(userId: string, input: EventInsert): Promise<TaskEvent>;

  // artifacts
  listArtifacts(userId: string, taskId: string): Promise<Artifact[]>;
  createArtifact(userId: string, input: ArtifactInsert): Promise<Artifact>;

  // jobs
  createJob(userId: string, input: JobInsert): Promise<Job>;
  getJob(userId: string, id: string): Promise<Job | null>;
  listJobsForTask(userId: string, taskId: string): Promise<Job[]>;
  updateJob(userId: string, id: string, patch: JobPatch): Promise<Job | null>;
  /** Atomically claim queued jobs, serialised per task (see `claim_jobs` in the migration). */
  claimJobs(userId: string, workerId: string, max: number): Promise<Job[]>;
  cancelQueuedJobs(userId: string, taskId: string): Promise<number>;
  /** Cross-user: claimed/running jobs, used by the stale-job sweeper. */
  listActiveJobs(): Promise<Job[]>;

  // job logs
  appendJobLog(userId: string, input: JobLogInsert): Promise<JobLog>;
  listJobLogs(userId: string, jobId: string): Promise<JobLog[]>;

  // workers
  listWorkers(userId: string): Promise<Worker[]>;
  getWorker(userId: string, id: string): Promise<Worker | null>;
  createWorker(userId: string, input: WorkerInsert): Promise<Worker>;
  updateWorker(userId: string, id: string, patch: WorkerPatch): Promise<Worker | null>;

  // worker keys
  listWorkerKeys(userId: string): Promise<WorkerKey[]>;
  createWorkerKey(userId: string, input: WorkerKeyInsert): Promise<WorkerKey>;
  revokeWorkerKey(userId: string, id: string): Promise<boolean>;
  /** Cross-user: authentication lookup by SHA-256 hash of the presented key. */
  findWorkerKeyByHash(keyHash: string): Promise<WorkerKeyLookup | null>;
  touchWorkerKey(userId: string, id: string, at: string): Promise<void>;

  // secrets
  getSecret(userId: string, provider: SecretProvider): Promise<StoredSecret | null>;
  listSecrets(userId: string): Promise<StoredSecret[]>;
  upsertSecret(userId: string, provider: SecretProvider, input: SecretUpsert): Promise<StoredSecret>;
  deleteSecret(userId: string, provider: SecretProvider): Promise<boolean>;
}
