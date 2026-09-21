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
  'done',
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
  | 'troubleshoot'; // diagnosis + resolved flag

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

export interface Message {
  id: string;
  taskId: string;
  role: MessageRole;
  content: string;
  source: MessageSource;
  /** e.g. GitHub comment id, used for idempotent ingestion. */
  externalId?: string | null;
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
  content: string;
  createdAt: string;
}

export interface Task {
  id: string;
  userId: string;
  /** Human-friendly key, e.g. ENG-142 (ticket id) or SIN-17. */
  key: string;
  title: string;
  description: string;
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
}

export type JobStatus = 'queued' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'agent' | 'rebase-stack';

export interface JobContext {
  task_key: string;
  task_title: string;
  task_description: string;
  plan: string;
  feedback: string;
  pr_url: string;
  parent_plan: string;
  sibling_summaries: string;
  review: string;
  verify_report: string;
  error: string;
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
  createdAt: string;
  claimedAt: string | null;
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

export type JobPayload = AgentJobPayload | RebaseStackJobPayload;

/** What the worker hands to the job runner: the job plus scoped credentials. */
export interface JobDispatch {
  job: Job;
  credentials: { githubToken: string | null };
}

/** Results the agent must write to the result file; validated by the worker and the server. */
export interface PlanResult {
  kind: 'plan';
  summary: string;
  plan: string;
  subtasks?: { title: string; goal: string }[];
}
export interface PrResult {
  kind: 'pr';
  summary: string;
  prUrl: string;
  branch: string;
}
export interface ReviewResult {
  kind: 'review';
  summary: string;
  report: string;
  verdict: 'MATERIAL_FINDINGS' | 'NO_MATERIAL_FINDINGS' | 'REVIEW_BLOCKED';
}
export interface VerdictResult {
  kind: 'verdict';
  summary: string;
  report: string;
  verdict: 'GO' | 'NO_GO';
  feedback?: string;
}
export interface DocumentResult {
  kind: 'document';
  summary: string;
  artifacts: { name: string; contentType: string; content: string }[];
}
export interface TroubleshootResult {
  kind: 'troubleshoot';
  summary: string;
  diagnosis: string;
  resolved: boolean;
}
export interface RebaseResult {
  kind: 'rebase';
  summary: string;
  rebased: { taskId: string; branch: string; ok: boolean; error?: string }[];
}

export type AgentResult =
  | PlanResult
  | PrResult
  | ReviewResult
  | VerdictResult
  | DocumentResult
  | TroubleshootResult
  | RebaseResult;

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

export interface TicketImport {
  provider: 'linear' | 'jira' | 'github';
  id: string;
  title: string;
  description: string;
  url: string;
}
