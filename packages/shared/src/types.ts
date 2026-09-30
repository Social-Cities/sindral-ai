/**
 * Core domain types shared by the server, web UI and worker.
 * Keep this file free of runtime dependencies.
 */

/** Well-known task states. Custom workflows may introduce additional string states. */
export const KNOWN_TASK_STATES = [
  'todo',
  'planning',
  'plan-review',
  'planning-feedback',
  'implement',
  'adversarial-review',
  'verify',
  'in-review',
  'implement-feedback',
  'conflict-resolution',
  'merge',
  'done',
  'wont-do',
  'failure',
  'troubleshoot',
] as const;

export type KnownTaskState = (typeof KNOWN_TASK_STATES)[number];
/** Task state is open so custom workflows can define their own step states. */
export type TaskState = KnownTaskState | (string & {});

export type StepType = 'agent' | 'human' | 'end';
export type AgentEngine = 'claude' | 'codex';
export type AgentMode = 'high' | 'normal' | 'low';
export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'run_command'
  | 'search_codebase'
  | 'list_directory'
  | 'create_pr'
  | 'web_search';
export type Permission = 'read' | 'write' | 'execute';

/**
 * What an agent step is expected to produce. Drives the result-file contract
 * the worker enforces and the server-side transition after completion.
 */
export type StepOutputKind =
  | 'plan' // markdown plan (+ optional subtasks)
  | 'pr' // code change pushed as a PR
  | 'review' // adversarial review report
  | 'verdict' // production readiness GO / NO_GO
  | 'document' // non-code deliverable(s) uploaded as artifacts
  | 'troubleshoot' // diagnosis + resolved flag
  | 'conflict-resolution' // rationale produced while resolving a stacked rebase
  | 'merge'; // worker-owned pull-request merge result

export interface WorkflowStep {
  id: string;
  type: StepType;
  label: string;
  /** Task state displayed while the task sits on this step. */
  state: TaskState;
  /** Agent-only configuration. */
  engine?: AgentEngine;
  model?: string;
  mode?: AgentMode;
  prompt?: string;
  tools?: ToolName[];
  permissions?: Permission[];
  output?: StepOutputKind;
  /** Optional canvas position for the workflow editor. */
  position?: { x: number; y: number };
}

/**
 * Events that move a task along an edge.
 * - Human steps: any event name is a button (`start`, `approve`, `accept`, ...);
 *   `feedback` is triggered when the user sends a chat message.
 * - Agent steps: `complete` on success. Verdict steps emit `reject` on NO_GO,
 *   troubleshoot steps emit `resolved` / `unresolved`.
 */
export type TransitionEvent = string;

export interface WorkflowEdge {
  from: string;
  to: string;
  event: TransitionEvent;
  /** Optional human-readable label, defaults to the event. */
  label?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  entryStepId: string;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  /** Optional per-workflow troubleshoot agent. Falls back to the built-in default. */
  troubleshootStep?: WorkflowStep;
}

export interface WorkflowRecord extends Workflow {
  userId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'agent' | 'system';
export type MessageSource = 'web' | 'github' | 'worker';
export type GitHubFeedbackKind = 'issue_comment' | 'review_comment';

export interface GitHubFeedbackReference {
  kind: GitHubFeedbackKind;
  commentId: string;
  commentUrl: string | null;
  prUrl: string;
}

export interface Message {
  id: string;
  taskId: string;
  role: MessageRole;
  content: string;
  source: MessageSource;
  /** e.g. GitHub comment id, used for idempotent ingestion. */
  externalId?: string | null;
  githubFeedback?: GitHubFeedbackReference | null;
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  fromState?: string | null;
  toState?: string | null;
  stepId?: string | null;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  jobId?: string | null;
  name: string;
  contentType: string;
  /** Small text artifacts are returned inline; stored artifacts use downloadUrl instead. */
  content: string | null;
  byteSize: number;
  /** Short-lived, owner-authorized URL for artifacts held in private object storage. */
  downloadUrl: string | null;
  createdAt: string;
}

export const ARTIFACT_CONTENT_TYPES = [
  'text/markdown',
  'text/plain',
  'application/json',
  'text/html',
  'text/csv',
  'text/yaml',
  'application/xml',
  'image/svg+xml',
] as const;

export type ArtifactContentType = (typeof ARTIFACT_CONTENT_TYPES)[number];
export const MAX_ARTIFACT_BYTES = 1_000_000;

export type PullRequestStatus = 'open' | 'merged' | 'closed';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ProjectRepository {
  id: string;
  userId: string;
  projectId: string;
  repository: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  repositories: ProjectRepository[];
}

export interface TaskRepository {
  id: string;
  userId: string;
  taskId: string;
  repository: string;
  branch: string;
  baseBranch: string | null;
  mergeMethod: MergeMethod;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: string;
  userId: string;
  taskId: string;
  taskRepositoryId: string;
  repository: string;
  url: string;
  number: number;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  status: PullRequestStatus;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  userId: string;
  /** Monotonic optimistic-concurrency token incremented by durable workflow commands. */
  version: number;
  /** Human-friendly key, e.g. ENG-142 (ticket id) or SIN-17. */
  key: string;
  title: string;
  description: string;
  /** Project that owns the repository set this task works against. Legacy/imported tasks may be null. */
  projectId: string | null;
  /** User-visible result the task is intended to achieve. Empty only until imported or generated by the first agent. */
  outcome: string;
  /** Observable conditions used by agents and humans to decide whether the outcome was achieved. */
  acceptanceCriteria: string;
  state: TaskState;
  currentStepId: string | null;
  workflowId: string | null;
  pinnedWorkflow: Workflow | null;
  /** GitHub repositories in `owner/name` form. Empty means a non-code task. */
  repos: string[];
  ticketUrl: string | null;
  prUrl: string | null;
  branch: string | null;
  baseBranch: string | null;
  plan: string | null;
  parentTaskId: string | null;
  /** 1-based position within the parent's subtask stack. */
  sequence: number | null;
  failedStepId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWithRelations extends Task {
  messages: Message[];
  events: TaskEvent[];
  artifacts: Artifact[];
  subtasks: Task[];
  repositories: TaskRepository[];
  pullRequests: PullRequest[];
}

export type JobStatus = 'queued' | 'claimed' | 'running' | 'applying' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'agent' | 'rebase-stack' | 'resolve-rebase-conflict' | 'merge-pull-requests';

export interface JobContext {
  task_key: string;
  task_title: string;
  task_description: string;
  task_outcome: string;
  acceptance_criteria: string;
  plan: string;
  feedback: string;
  pr_url: string;
  parent_plan: string;
  sibling_summaries: string;
  review: string;
  verify_report: string;
  error: string;
  github_feedback?: GitHubFeedbackReference;
}

export interface Job {
  id: string;
  userId: string;
  taskId: string;
  kind: JobKind;
  stepId: string | null;
  status: JobStatus;
  workerId: string | null;
  attempt: number;
  payload: JobPayload;
  result: AgentResult | null;
  error: string | null;
  outcomeHash: string | null;
  outcomeToken: string | null;
  outcomeStartedAt: string | null;
  dedupeKey: string | null;
  createdAt: string;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
}

export interface AgentJobPayload {
  kind: 'agent';
  step: WorkflowStep;
  context: JobContext;
  repos: string[];
  branch: string | null;
  baseBranch: string | null;
  /** Existing PR to update, if any. */
  prUrl: string | null;
}

export interface RebaseStackJobPayload {
  kind: 'rebase-stack';
  repos: string[];
  /** Ordered list of branches to rebase, each onto the previous. */
  stack: { taskId: string; branch: string; baseBranch: string }[];
}

export interface ConflictResolutionPolicy {
  /** Repository-relative paths that may be edited. The conflicted paths are always required too. */
  allowedPaths: string[];
  /** Repository-relative glob-like prefixes/suffixes which always require human review. */
  protectedPaths: string[];
  /** Executable + argv commands run without a shell after the rebase completes. */
  validationCommands: string[][];
  maxFiles: number;
  maxChangedLines: number;
}

export interface ResolveRebaseConflictJobPayload {
  kind: 'resolve-rebase-conflict';
  repository: string;
  taskId: string;
  taskKey: string;
  branch: string;
  baseBranch: string;
  sourceSha: string;
  targetSha: string;
  conflictedPaths: string[];
  context: JobContext;
  engine: AgentEngine;
  model: string;
  mode: AgentMode;
  policy: ConflictResolutionPolicy;
}

export interface MergePullRequestsJobPayload {
  kind: 'merge-pull-requests';
  pullRequests: {
    id: string;
    repository: string;
    url: string;
    number: number;
    headSha: string;
    method: MergeMethod;
  }[];
}

export type JobPayload = AgentJobPayload | RebaseStackJobPayload | ResolveRebaseConflictJobPayload | MergePullRequestsJobPayload;

/** What the worker hands to the job runner: the job plus scoped credentials. */
export interface JobDispatch {
  job: Job;
  lease: { token: string; expiresAt: string };
  credentials: { githubToken: string | null; githubCredential: 'github-app' | 'pat' | null };
}

/** Results the agent must write to the result file; validated by the worker and the server. */
export interface TaskContractResult {
  /** Required when the task did not already have a durable outcome. */
  outcome?: string;
  /** Required when the task did not already have durable acceptance criteria. */
  acceptanceCriteria?: string;
}

export interface PlanResult extends TaskContractResult {
  kind: 'plan';
  summary: string;
  plan: string;
  subtasks?: { title: string; goal: string }[];
}
export interface PrResult extends TaskContractResult {
  kind: 'pr';
  summary: string;
  prUrl: string;
  branch: string;
  pullRequests?: {
    repository: string;
    prUrl: string;
    number: number;
    branch: string;
    baseBranch: string;
    headSha?: string;
  }[];
}
export interface ReviewResult extends TaskContractResult {
  kind: 'review';
  summary: string;
  report: string;
  verdict: 'MATERIAL_FINDINGS' | 'NO_MATERIAL_FINDINGS' | 'REVIEW_BLOCKED';
}
export interface VerdictResult extends TaskContractResult {
  kind: 'verdict';
  summary: string;
  report: string;
  verdict: 'GO' | 'NO_GO';
  feedback?: string;
}
export interface DocumentResult extends TaskContractResult {
  kind: 'document';
  summary: string;
  artifacts: { name: string; contentType: string; content: string }[];
}
export interface TroubleshootResult extends TaskContractResult {
  kind: 'troubleshoot';
  summary: string;
  diagnosis: string;
  resolved: boolean;
}
export interface RebaseResult {
  kind: 'rebase';
  summary: string;
  rebased: {
    taskId: string;
    branch: string;
    ok: boolean;
    /** New remote head after a successful history rewrite. */
    headSha?: string;
    error?: string;
    conflict?: {
      repository: string;
      baseBranch: string;
      sourceSha: string;
      targetSha: string;
      conflictedPaths: string[];
    };
  }[];
}
export interface ConflictResolutionResult {
  kind: 'conflict-resolution';
  summary: string;
  taskId: string;
  branch: string;
  resolved: boolean;
  rationale: string;
  resolvedPaths: string[];
  checks: { command: string[]; ok: boolean; output: string }[];
  resolutionCommit?: string;
  resolutionDiffHash?: string;
  error?: string;
}
export interface MergeResult {
  kind: 'merge';
  summary: string;
  complete: boolean;
  pullRequests: {
    id: string;
    repository: string;
    url: string;
    merged: boolean;
    mergedAt?: string;
    error?: string;
  }[];
}

export type AgentResult =
  | PlanResult
  | PrResult
  | ReviewResult
  | VerdictResult
  | DocumentResult
  | TroubleshootResult
  | RebaseResult
  | ConflictResolutionResult
  | MergeResult;

export type WorkerStatus = 'online' | 'offline';

export interface Worker {
  id: string;
  userId: string;
  name: string;
  hostname: string;
  version: string;
  status: WorkerStatus;
  runningJobs: number;
  lastSeenAt: string;
  createdAt: string;
}

export interface WorkerKey {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type SecretProvider = 'github' | 'linear' | 'jira';

export interface SecretStatus {
  provider: SecretProvider;
  configured: boolean;
  updatedAt: string | null;
  /** Non-sensitive hint, e.g. last 4 characters. */
  hint: string | null;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
  defaultBranch: string;
  pushedAt: string | null;
  owner: string;
}

export interface GitHubOwner {
  login: string;
  type: 'user' | 'organization';
  avatarUrl: string | null;
  role: 'owner' | 'admin' | 'member';
}

export interface GitHubCatalog {
  connected: boolean;
  source: 'oauth' | 'pat' | null;
  repositories: GitHubRepository[];
  owners: GitHubOwner[];
}

export interface TicketImport {
  provider: 'linear' | 'jira' | 'github';
  id: string;
  title: string;
  description: string;
  url: string;
}
