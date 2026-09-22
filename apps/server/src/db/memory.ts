import { randomUUID } from 'node:crypto';
import { ARTIFACT_CONTENT_TYPES, MAX_ARTIFACT_BYTES } from '@sindral/shared';
import type { AgentResult, Artifact, Job, JobKind, Message, PullRequest, SecretProvider, Task, TaskEvent, TaskRepository, Worker, WorkerKey, WorkflowRecord } from '@sindral/shared';
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

type Owned<T> = T & { userId: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-memory repository used by tests. Maps preserve insertion order, which doubles
 * as "oldest first" ordering. Rows are cloned on the way in and out so callers
 * cannot mutate stored state by accident.
 */
export class MemoryRepository implements Repository {
  private readonly profiles = new Map<string, Profile & { taskCounter: number }>();
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly tasks = new Map<string, Task>();
  private readonly taskRepositories = new Map<string, TaskRepository>();
  private readonly pullRequests = new Map<string, PullRequest>();
  private readonly messages = new Map<string, Owned<Message>>();
  private readonly events = new Map<string, Owned<TaskEvent>>();
  private readonly eventDedupe = new Map<string, string>();
  private readonly artifacts = new Map<string, Owned<Artifact>>();
  private readonly artifactDedupe = new Map<string, string>();
  private readonly jobs = new Map<string, Job>();
  private readonly jobLeaseTokens = new Map<string, string>();
  private readonly jobLogs = new Map<number, Owned<JobLog>>();
  private readonly workers = new Map<string, Worker>();
  private readonly workerKeys = new Map<string, WorkerKeyLookup>();
  private readonly secrets = new Map<string, StoredSecret>();
  private readonly transitionCommands = new Map<string, { requestHash: string; result: TaskTransitionResult }>();
  private readonly webhookDeliveries = new Map<
    string,
    { eventName: string; payloadHash: string; token: string; startedAt: number; response: WebhookDeliveryResponse | null }
  >();
  private logSeq = 0;

  private now(): string {
    return new Date().toISOString();
  }

  // ---- profiles ----
  async ensureProfile(userId: string, displayNameHint: string | null): Promise<Profile> {
    let profile = this.profiles.get(userId);
    if (!profile) {
      profile = { id: userId, displayName: displayNameHint, githubUsername: null, taskCounter: 0 };
      this.profiles.set(userId, profile);
    }
    const { taskCounter: _taskCounter, ...rest } = profile;
    return clone(rest);
  }

  async nextTaskNumber(userId: string): Promise<number> {
    await this.ensureProfile(userId, null);
    const profile = this.profiles.get(userId)!;
    profile.taskCounter += 1;
    return profile.taskCounter;
  }

  // ---- workflows ----
  async listWorkflows(userId: string): Promise<WorkflowRecord[]> {
    return [...this.workflows.values()].filter((w) => w.userId === userId).map(clone);
  }

  async getWorkflow(userId: string, id: string): Promise<WorkflowRecord | null> {
    const w = this.workflows.get(id);
    return w && w.userId === userId ? clone(w) : null;
  }

  async createWorkflow(userId: string, input: WorkflowInsert): Promise<WorkflowRecord> {
    const ts = this.now();
    const record: WorkflowRecord = { ...clone(input.definition), id: input.id, userId, isDefault: input.isDefault, createdAt: ts, updatedAt: ts };
    this.workflows.set(record.id, record);
    return clone(record);
  }

  async updateWorkflow(userId: string, id: string, patch: WorkflowPatch): Promise<WorkflowRecord | null> {
    const existing = this.workflows.get(id);
    if (!existing || existing.userId !== userId) return null;
    const next: WorkflowRecord = {
      ...(patch.definition ? { ...clone(patch.definition), id } : existing),
      userId,
      isDefault: patch.isDefault ?? existing.isDefault,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };
    this.workflows.set(id, next);
    return clone(next);
  }

  async deleteWorkflow(userId: string, id: string): Promise<boolean> {
    const existing = this.workflows.get(id);
    if (!existing || existing.userId !== userId) return false;
    this.workflows.delete(id);
    for (const task of this.tasks.values()) {
      if (task.workflowId === id) task.workflowId = null;
    }
    return true;
  }

  // ---- tasks ----
  async createTask(userId: string, input: TaskInsert): Promise<Task> {
    for (const t of this.tasks.values()) {
      if (t.userId === userId && t.key === input.key) throw new ConflictError(`Task key ${input.key} already exists`);
    }
    const ts = this.now();
    const task: Task = {
      id: randomUUID(),
      userId,
      version: 0,
      key: input.key,
      title: input.title,
      description: input.description,
      state: input.state,
      currentStepId: input.currentStepId,
      workflowId: input.workflowId,
      pinnedWorkflow: clone(input.pinnedWorkflow),
      repos: [...input.repos],
      ticketUrl: input.ticketUrl,
      prUrl: null,
      branch: input.branch,
      baseBranch: input.baseBranch,
      plan: null,
      parentTaskId: input.parentTaskId,
      sequence: input.sequence,
      failedStepId: null,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.tasks.set(task.id, task);
    return clone(task);
  }

  async getTask(userId: string, id: string): Promise<Task | null> {
    const t = this.tasks.get(id);
    return t && t.userId === userId ? clone(t) : null;
  }

  async listTasks(userId: string, filter: TaskFilter): Promise<Task[]> {
    const search = filter.search?.trim().toLowerCase();
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId)
      .filter((t) => (filter.parentTaskId ? t.parentTaskId === filter.parentTaskId : filter.includeSubtasks || t.parentTaskId === null))
      .filter((t) => !filter.state || t.state === filter.state)
      .filter((t) => !filter.workflowId || t.workflowId === filter.workflowId)
      .filter((t) => !search || t.title.toLowerCase().includes(search) || t.key.toLowerCase().includes(search))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(clone);
  }

  async listSubtasks(userId: string, parentTaskId: string): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId && t.parentTaskId === parentTaskId)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map(clone);
  }

  async updateTask(userId: string, id: string, patch: TaskPatch): Promise<Task | null> {
    const t = this.tasks.get(id);
    if (!t || t.userId !== userId) return null;
    Object.assign(t, clone(patch), { updatedAt: this.now() });
    return clone(t);
  }

  async getTaskTransitionReplay(userId: string, idempotencyKey: string, requestHash: string): Promise<TaskTransitionResult | null> {
    const recorded = this.transitionCommands.get(`${userId}:${idempotencyKey}`);
    if (!recorded) return null;
    if (recorded.requestHash !== requestHash) throw new ConflictError('Idempotency key was already used for a different request');
    return clone({ ...recorded.result, replayed: true });
  }

  async getTaskTransitionReplayByKey(userId: string, idempotencyKey: string): Promise<TaskTransitionResult | null> {
    const recorded = this.transitionCommands.get(`${userId}:${idempotencyKey}`);
    return recorded ? clone({ ...recorded.result, replayed: true }) : null;
  }

  async applyTaskTransition(userId: string, command: TaskTransitionCommand): Promise<TaskTransitionResult> {
    const ledgerKey = `${userId}:${command.idempotencyKey}`;
    const recorded = this.transitionCommands.get(ledgerKey);
    if (recorded) {
      if (recorded.requestHash !== command.requestHash) throw new ConflictError('Idempotency key was already used for a different request');
      return clone({ ...recorded.result, replayed: true });
    }

    const task = this.tasks.get(command.taskId);
    if (!task || task.userId !== userId) throw new ConflictError('Task does not exist or is not owned by this user');
    if (task.version !== command.expectedVersion) {
      throw new ConflictError(`Task version ${command.expectedVersion} is stale; current version is ${task.version}`);
    }

    Object.assign(task, clone(command.patch), { version: task.version + 1, updatedAt: this.now() });
    const event: Owned<TaskEvent> = {
      id: randomUUID(),
      userId,
      taskId: command.event.taskId,
      type: command.event.type,
      fromState: command.event.fromState ?? null,
      toState: command.event.toState ?? null,
      stepId: command.event.stepId ?? null,
      detail: command.event.detail ? clone(command.event.detail) : null,
      createdAt: this.now(),
    };
    this.events.set(event.id, event);

    let job: Job | null = null;
    if (command.job) {
      job = {
        id: randomUUID(),
        userId,
        taskId: command.job.taskId,
        kind: command.job.kind,
        stepId: command.job.stepId,
        status: 'queued',
        workerId: null,
        attempt: 1,
        payload: clone(command.job.payload),
        result: null,
        error: null,
        outcomeHash: null,
        outcomeToken: null,
        outcomeStartedAt: null,
        dedupeKey: command.job.dedupeKey ?? null,
        createdAt: this.now(),
        claimedAt: null,
        leaseExpiresAt: null,
        finishedAt: null,
      };
      this.jobs.set(job.id, job);
      const queued: Owned<TaskEvent> = {
        id: randomUUID(),
        userId,
        taskId: command.taskId,
        type: 'job-queued',
        fromState: null,
        toState: null,
        stepId: job.stepId,
        detail: { jobId: job.id, kind: job.kind },
        createdAt: this.now(),
      };
      this.events.set(queued.id, queued);
    }
    if (command.cancelQueuedJobs) {
      for (const candidate of this.jobs.values()) {
        if (candidate.userId === userId && candidate.taskId === command.taskId && candidate.status === 'queued' && candidate.id !== job?.id) {
          candidate.status = 'cancelled';
          candidate.finishedAt = this.now();
        }
      }
    }
    const result = { task: clone(task), job: job ? clone(job) : null, replayed: false };
    this.transitionCommands.set(ledgerKey, { requestHash: command.requestHash, result: clone(result) });
    return result;
  }

  async deleteTask(userId: string, id: string): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t || t.userId !== userId) return false;
    for (const child of [...this.tasks.values()].filter((c) => c.parentTaskId === id)) await this.deleteTask(userId, child.id);
    this.tasks.delete(id);
    for (const [k, record] of this.taskRepositories) if (record.taskId === id) this.taskRepositories.delete(k);
    for (const [k, record] of this.pullRequests) if (record.taskId === id) this.pullRequests.delete(k);
    for (const [k, m] of this.messages) if (m.taskId === id) this.messages.delete(k);
    for (const [k, e] of this.events) if (e.taskId === id) this.events.delete(k);
    for (const [k, a] of this.artifacts) if (a.taskId === id) this.artifacts.delete(k);
    for (const [k, j] of this.jobs) {
      if (j.taskId !== id) continue;
      this.jobs.delete(k);
      for (const [lk, l] of this.jobLogs) if (l.jobId === k) this.jobLogs.delete(lk);
    }
    return true;
  }

  async findTaskByPrUrl(prUrl: string): Promise<Task | null> {
    const pullRequest = await this.findPullRequestByUrl(prUrl);
    if (pullRequest) return this.getTask(pullRequest.userId, pullRequest.taskId);
    for (const t of this.tasks.values()) if (t.prUrl === prUrl) return clone(t);
    return null;
  }

  // ---- task repositories and pull requests ----
  async listTaskRepositories(userId: string, taskId: string): Promise<TaskRepository[]> {
    return [...this.taskRepositories.values()].filter((record) => record.userId === userId && record.taskId === taskId).map(clone);
  }

  async upsertTaskRepository(userId: string, taskId: string, input: TaskRepositoryUpsert): Promise<TaskRepository> {
    const existing = [...this.taskRepositories.values()].find(
      (record) => record.userId === userId && record.taskId === taskId && record.repository === input.repository,
    );
    const ts = this.now();
    const record: TaskRepository = existing
      ? { ...existing, branch: input.branch, baseBranch: input.baseBranch, mergeMethod: input.mergeMethod ?? existing.mergeMethod, updatedAt: ts }
      : {
          id: randomUUID(),
          userId,
          taskId,
          repository: input.repository,
          branch: input.branch,
          baseBranch: input.baseBranch,
          mergeMethod: input.mergeMethod ?? 'squash',
          createdAt: ts,
          updatedAt: ts,
        };
    this.taskRepositories.set(record.id, record);
    return clone(record);
  }

  async deleteTaskRepositoriesNotIn(userId: string, taskId: string, repositories: string[]): Promise<void> {
    const keep = new Set(repositories);
    for (const [id, record] of this.taskRepositories) {
      if (record.userId === userId && record.taskId === taskId && !keep.has(record.repository)) {
        this.taskRepositories.delete(id);
        for (const [prId, pr] of this.pullRequests) if (pr.taskRepositoryId === id) this.pullRequests.delete(prId);
      }
    }
  }

  async listPullRequests(userId: string, taskId: string): Promise<PullRequest[]> {
    return [...this.pullRequests.values()].filter((record) => record.userId === userId && record.taskId === taskId).map(clone);
  }

  async upsertPullRequest(userId: string, taskId: string, input: PullRequestUpsert): Promise<PullRequest> {
    const existing = [...this.pullRequests.values()].find(
      (record) => record.userId === userId && record.taskId === taskId && record.repository === input.repository,
    );
    const ts = this.now();
    const record: PullRequest = existing
      ? {
          ...existing,
          taskRepositoryId: input.taskRepositoryId,
          url: input.url,
          number: input.number,
          branch: input.branch,
          baseBranch: input.baseBranch,
          headSha: input.headSha,
          status: input.status ?? existing.status,
          mergedAt: input.mergedAt === undefined ? existing.mergedAt : input.mergedAt,
          updatedAt: ts,
        }
      : {
          id: randomUUID(),
          userId,
          taskId,
          taskRepositoryId: input.taskRepositoryId,
          repository: input.repository,
          url: input.url,
          number: input.number,
          branch: input.branch,
          baseBranch: input.baseBranch,
          headSha: input.headSha,
          status: input.status ?? 'open',
          mergedAt: input.mergedAt ?? null,
          createdAt: ts,
          updatedAt: ts,
        };
    this.pullRequests.set(record.id, record);
    return clone(record);
  }

  async findPullRequestByUrl(prUrl: string): Promise<PullRequest | null> {
    for (const record of this.pullRequests.values()) if (record.url === prUrl) return clone(record);
    return null;
  }

  // ---- messages ----
  async listMessages(userId: string, taskId: string): Promise<Message[]> {
    return [...this.messages.values()].filter((m) => m.userId === userId && m.taskId === taskId).map(({ userId: _u, ...m }) => clone(m));
  }

  async createMessage(userId: string, input: MessageInsert): Promise<Message | null> {
    const externalId = input.externalId ?? null;
    if (externalId !== null) {
      for (const m of this.messages.values()) if (m.taskId === input.taskId && m.externalId === externalId) return null;
    }
    const message: Owned<Message> = {
      id: randomUUID(),
      userId,
      taskId: input.taskId,
      role: input.role,
      content: input.content,
      source: input.source,
      externalId,
      githubFeedback: input.githubFeedback ? clone(input.githubFeedback) : null,
      createdAt: this.now(),
    };
    this.messages.set(message.id, message);
    const { userId: _u, ...out } = message;
    return clone(out);
  }

  async beginWebhookDelivery(deliveryId: string, eventName: string, payloadHash: string): Promise<WebhookDeliveryClaim> {
    const existing = this.webhookDeliveries.get(deliveryId);
    if (existing) {
      if (existing.eventName !== eventName || existing.payloadHash !== payloadHash) throw new ConflictError('GitHub delivery ID was reused with different content');
      if (existing.response) return { state: 'replay', token: null, response: clone(existing.response) };
      if (existing.startedAt > Date.now() - 30_000) return { state: 'busy', token: null, response: null };
    }
    const token = randomUUID();
    this.webhookDeliveries.set(deliveryId, { eventName, payloadHash, token, startedAt: Date.now(), response: null });
    return { state: 'acquired', token, response: null };
  }

  async finalizeWebhookDelivery(deliveryId: string, payloadHash: string, token: string, response: WebhookDeliveryResponse): Promise<void> {
    const delivery = this.webhookDeliveries.get(deliveryId);
    if (!delivery || delivery.payloadHash !== payloadHash || delivery.token !== token) throw new ConflictError('GitHub delivery lease was superseded');
    delivery.response = clone(response);
  }

  async abandonWebhookDelivery(deliveryId: string, payloadHash: string, token: string): Promise<void> {
    const delivery = this.webhookDeliveries.get(deliveryId);
    if (delivery?.payloadHash === payloadHash && delivery.token === token && !delivery.response) this.webhookDeliveries.delete(deliveryId);
  }

  // ---- events ----
  async listEvents(userId: string, taskId: string): Promise<TaskEvent[]> {
    return [...this.events.values()].filter((e) => e.userId === userId && e.taskId === taskId).map(({ userId: _u, ...e }) => clone(e));
  }

  async createEvent(userId: string, input: EventInsert): Promise<TaskEvent> {
    if (input.dedupeKey) {
      const existingId = this.eventDedupe.get(`${input.taskId}:${input.dedupeKey}`);
      const existing = existingId ? this.events.get(existingId) : undefined;
      if (existing && existing.userId === userId) {
        const { userId: _u, ...out } = existing;
        return clone(out);
      }
    }
    const event: Owned<TaskEvent> = {
      id: randomUUID(),
      userId,
      taskId: input.taskId,
      type: input.type,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      stepId: input.stepId ?? null,
      detail: input.detail ? clone(input.detail) : null,
      createdAt: this.now(),
    };
    this.events.set(event.id, event);
    if (input.dedupeKey) this.eventDedupe.set(`${input.taskId}:${input.dedupeKey}`, event.id);
    const { userId: _u, ...out } = event;
    return clone(out);
  }

  // ---- artifacts ----
  async listArtifacts(userId: string, taskId: string): Promise<Artifact[]> {
    return [...this.artifacts.values()].filter((a) => a.userId === userId && a.taskId === taskId).map(({ userId: _u, ...a }) => clone(a));
  }

  async createArtifact(userId: string, input: ArtifactInsert): Promise<Artifact> {
    if (input.dedupeKey) {
      const existingId = this.artifactDedupe.get(`${input.taskId}:${input.dedupeKey}`);
      const existing = existingId ? this.artifacts.get(existingId) : undefined;
      if (existing && existing.userId === userId) {
        const { userId: _u, ...out } = existing;
        return clone(out);
      }
    }
    if (!ARTIFACT_CONTENT_TYPES.includes(input.contentType as (typeof ARTIFACT_CONTENT_TYPES)[number])) {
      throw new RepositoryError(`Unsupported artifact content type: ${input.contentType}`, '22023');
    }
    const byteSize = Buffer.byteLength(input.content, 'utf8');
    if (byteSize > MAX_ARTIFACT_BYTES) throw new RepositoryError(`Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte limit`, '22001');
    const artifact: Owned<Artifact> = {
      id: randomUUID(),
      userId,
      taskId: input.taskId,
      jobId: input.jobId ?? null,
      name: input.name,
      contentType: input.contentType,
      content: input.content,
      byteSize,
      downloadUrl: null,
      createdAt: this.now(),
    };
    this.artifacts.set(artifact.id, artifact);
    if (input.dedupeKey) this.artifactDedupe.set(`${input.taskId}:${input.dedupeKey}`, artifact.id);
    const { userId: _u, ...out } = artifact;
    return clone(out);
  }

  // ---- jobs ----
  async createJob(userId: string, input: JobInsert): Promise<Job> {
    if (input.dedupeKey) {
      for (const existing of this.jobs.values()) {
        if (existing.userId === userId && existing.dedupeKey === input.dedupeKey) return clone(existing);
      }
    }
    const job: Job = {
      id: randomUUID(),
      userId,
      taskId: input.taskId,
      kind: input.kind,
      stepId: input.stepId,
      status: 'queued',
      workerId: null,
      attempt: 1,
      payload: clone(input.payload),
      result: null,
      error: null,
      outcomeHash: null,
      outcomeToken: null,
      outcomeStartedAt: null,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: this.now(),
      claimedAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    return clone(job);
  }

  async beginJobOutcome(
    userId: string,
    jobId: string,
    attempt: number,
    outcomeHash: string,
    outcome: { result: AgentResult; error?: never } | { error: string; result?: never },
    leaseToken: string,
  ): Promise<JobOutcomeClaim> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) throw new ConflictError('Job does not exist or is not owned by this user');
    if (job.attempt !== attempt || this.jobLeaseTokens.get(jobId) !== leaseToken) throw new ConflictError('Job lease has been superseded');
    if (job.outcomeHash && job.outcomeHash !== outcomeHash) throw new ConflictError('Job outcome does not match the accepted outcome');
    if (job.status === 'completed' || job.status === 'failed') return { job: clone(job), state: 'replay', token: null };
    if (job.status === 'applying' && job.outcomeStartedAt && Date.parse(job.outcomeStartedAt) > Date.now() - 30_000) {
      return { job: clone(job), state: 'busy', token: null };
    }
    if (job.status !== 'claimed' && job.status !== 'running' && job.status !== 'applying') throw new ConflictError(`Job is ${job.status}`);
    if (job.status !== 'applying' && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now())) throw new ConflictError('Job lease has expired');
    const token = randomUUID();
    Object.assign(job, {
      status: 'applying' as const,
      outcomeHash,
      outcomeToken: token,
      outcomeStartedAt: this.now(),
      result: outcome.result ?? null,
      error: outcome.error ?? null,
    });
    return { job: clone(job), state: 'acquired', token };
  }

  async finalizeJobOutcome(
    userId: string,
    jobId: string,
    attempt: number,
    outcomeHash: string,
    token: string,
    status: 'completed' | 'failed',
  ): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) throw new ConflictError('Job does not exist or is not owned by this user');
    if (job.status === status && job.attempt === attempt && job.outcomeHash === outcomeHash) return clone(job);
    if (job.status !== 'applying' || job.attempt !== attempt || job.outcomeHash !== outcomeHash || job.outcomeToken !== token) {
      throw new ConflictError('Job outcome lease was superseded');
    }
    Object.assign(job, { status, outcomeToken: null, finishedAt: this.now() });
    return clone(job);
  }

  async abandonJobOutcome(userId: string, jobId: string, attempt: number, outcomeHash: string, token: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job?.userId === userId && job.status === 'applying' && job.attempt === attempt && job.outcomeHash === outcomeHash && job.outcomeToken === token) {
      Object.assign(job, { status: 'running', outcomeToken: null, outcomeStartedAt: null, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() });
    }
  }

  async getJob(userId: string, id: string): Promise<Job | null> {
    const j = this.jobs.get(id);
    return j && j.userId === userId ? clone(j) : null;
  }

  async listJobsForTask(userId: string, taskId: string): Promise<Job[]> {
    return [...this.jobs.values()].filter((j) => j.userId === userId && j.taskId === taskId).map(clone);
  }

  async updateJob(userId: string, id: string, patch: JobPatch): Promise<Job | null> {
    const j = this.jobs.get(id);
    if (!j || j.userId !== userId) return null;
    Object.assign(j, clone(patch));
    if (patch.status === 'queued') this.jobLeaseTokens.delete(id);
    return clone(j);
  }

  async claimJobs(userId: string, workerId: string, max: number, allowedKinds?: JobKind[]): Promise<ClaimedJob[]> {
    const limit = Math.max(1, Math.min(max, 10));
    const busyTasks = new Set<string>();
    for (const j of this.jobs.values()) {
      if (j.userId === userId && (j.status === 'claimed' || j.status === 'running' || j.status === 'applying')) busyTasks.add(j.taskId);
    }
    const claimed: ClaimedJob[] = [];
    for (const j of this.jobs.values()) {
      if (claimed.length >= limit) break;
      if (j.userId !== userId || j.status !== 'queued' || busyTasks.has(j.taskId) || (allowedKinds && !allowedKinds.includes(j.kind))) continue;
      j.status = 'claimed';
      j.workerId = workerId;
      j.claimedAt = this.now();
      j.leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
      const leaseToken = randomUUID();
      this.jobLeaseTokens.set(j.id, leaseToken);
      busyTasks.add(j.taskId);
      claimed.push({ ...clone(j), leaseToken });
    }
    return claimed;
  }

  async renewJobLeases(userId: string, workerId: string, jobs: { jobId: string; leaseToken: string }[]): Promise<number> {
    const tokens = new Map(jobs.map((job) => [job.jobId, job.leaseToken]));
    let renewed = 0;
    for (const job of this.jobs.values()) {
      if (
        job.userId === userId && job.workerId === workerId && tokens.get(job.id) === this.jobLeaseTokens.get(job.id) &&
        job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > Date.now() && (job.status === 'claimed' || job.status === 'running')
      ) {
        job.leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
        renewed += 1;
      }
    }
    return renewed;
  }

  async activateJobLease(userId: string, jobId: string, attempt: number, leaseToken: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    const valid = Boolean(
      job && job.userId === userId && job.attempt === attempt && this.jobLeaseTokens.get(jobId) === leaseToken && job.leaseExpiresAt &&
      Date.parse(job.leaseExpiresAt) > Date.now() && (job.status === 'claimed' || job.status === 'running'),
    );
    if (valid) job!.status = 'running';
    return valid;
  }

  async cancelQueuedJobs(userId: string, taskId: string): Promise<number> {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.userId === userId && j.taskId === taskId && j.status === 'queued') {
        j.status = 'cancelled';
        j.finishedAt = this.now();
        n += 1;
      }
    }
    return n;
  }

  async listActiveJobs(): Promise<ActiveJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'claimed' || j.status === 'running' || j.status === 'applying')
      .map((job) => ({ ...clone(job), leaseToken: this.jobLeaseTokens.get(job.id) ?? null }));
  }

  async listActiveJobsForWorker(userId: string, workerId: string): Promise<ActiveJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId && job.workerId === workerId && (job.status === 'claimed' || job.status === 'running' || job.status === 'applying'))
      .map((job) => ({ ...clone(job), leaseToken: this.jobLeaseTokens.get(job.id) ?? null }));
  }

  // ---- job logs ----
  async appendJobLog(userId: string, input: JobLogInsert): Promise<JobLog> {
    this.logSeq += 1;
    const log: Owned<JobLog> = { id: this.logSeq, userId, jobId: input.jobId, type: input.type, message: input.message, createdAt: this.now() };
    this.jobLogs.set(log.id, log);
    const { userId: _u, ...out } = log;
    return clone(out);
  }

  async listJobLogs(userId: string, jobId: string): Promise<JobLog[]> {
    return [...this.jobLogs.values()].filter((l) => l.userId === userId && l.jobId === jobId).map(({ userId: _u, ...l }) => clone(l));
  }

  // ---- workers ----
  async listWorkers(userId: string): Promise<Worker[]> {
    return [...this.workers.values()].filter((w) => w.userId === userId).map(clone);
  }

  async getWorker(userId: string, id: string): Promise<Worker | null> {
    const w = this.workers.get(id);
    return w && w.userId === userId ? clone(w) : null;
  }

  async createWorker(userId: string, input: WorkerInsert): Promise<Worker> {
    const ts = this.now();
    const worker: Worker = {
      id: randomUUID(),
      userId,
      name: input.name,
      hostname: input.hostname,
      version: input.version,
      status: 'online',
      runningJobs: 0,
      lastSeenAt: ts,
      createdAt: ts,
    };
    this.workers.set(worker.id, worker);
    return clone(worker);
  }

  async updateWorker(userId: string, id: string, patch: WorkerPatch): Promise<Worker | null> {
    const w = this.workers.get(id);
    if (!w || w.userId !== userId) return null;
    Object.assign(w, clone(patch));
    return clone(w);
  }

  // ---- worker keys ----
  async listWorkerKeys(userId: string): Promise<WorkerKey[]> {
    return [...this.workerKeys.values()].filter((k) => k.userId === userId).map(({ keyHash: _h, ...k }) => clone(k));
  }

  async createWorkerKey(userId: string, input: WorkerKeyInsert): Promise<WorkerKey> {
    const key: WorkerKeyLookup = {
      id: randomUUID(),
      userId,
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.workerKeys.set(key.id, key);
    const { keyHash: _h, ...out } = key;
    return clone(out);
  }

  async revokeWorkerKey(userId: string, id: string): Promise<boolean> {
    const k = this.workerKeys.get(id);
    if (!k || k.userId !== userId) return false;
    if (!k.revokedAt) k.revokedAt = this.now();
    return true;
  }

  async findWorkerKeyByHash(keyHash: string): Promise<WorkerKeyLookup | null> {
    for (const k of this.workerKeys.values()) if (k.keyHash === keyHash) return clone(k);
    return null;
  }

  async touchWorkerKey(userId: string, id: string, at: string): Promise<void> {
    const k = this.workerKeys.get(id);
    if (k && k.userId === userId) k.lastUsedAt = at;
  }

  // ---- secrets ----
  private secretKey(userId: string, provider: SecretProvider): string {
    return `${userId}:${provider}`;
  }

  async getSecret(userId: string, provider: SecretProvider): Promise<StoredSecret | null> {
    const s = this.secrets.get(this.secretKey(userId, provider));
    return s ? clone(s) : null;
  }

  async listSecrets(userId: string): Promise<StoredSecret[]> {
    return [...this.secrets.values()].filter((s) => s.userId === userId).map(clone);
  }

  async upsertSecret(userId: string, provider: SecretProvider, input: SecretUpsert): Promise<StoredSecret> {
    const key = this.secretKey(userId, provider);
    const existing = this.secrets.get(key);
    const ts = this.now();
    const secret: StoredSecret = {
      userId,
      provider,
      ciphertext: input.ciphertext,
      iv: input.iv,
      authTag: input.authTag,
      hint: input.hint,
      metadata: clone(input.metadata),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.secrets.set(key, secret);
    return clone(secret);
  }

  async deleteSecret(userId: string, provider: SecretProvider): Promise<boolean> {
    return this.secrets.delete(this.secretKey(userId, provider));
  }

  async getOperationalSnapshot(now = new Date()): Promise<OperationalSnapshot> {
    const taskStates: Record<string, number> = {};
    const jobStatuses: Record<string, number> = {};
    for (const task of this.tasks.values()) taskStates[task.state] = (taskStates[task.state] ?? 0) + 1;
    for (const job of this.jobs.values()) jobStatuses[job.status] = (jobStatuses[job.status] ?? 0) + 1;
    const ages = [...this.workers.values()].map((worker) => Math.max(0, (now.getTime() - Date.parse(worker.lastSeenAt)) / 1000));
    return {
      taskStates,
      jobStatuses,
      workerCount: this.workers.size,
      oldestWorkerHeartbeatAgeSeconds: ages.length > 0 ? Math.max(...ages) : 0,
    };
  }
}
