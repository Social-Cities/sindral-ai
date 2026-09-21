import { randomUUID } from 'node:crypto';
import type { Artifact, Job, Message, SecretProvider, Task, TaskEvent, Worker, WorkerKey, WorkflowRecord } from '@sindral/shared';
import {
  ConflictError,
  type ArtifactInsert,
  type EventInsert,
  type JobInsert,
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
  type WorkerInsert,
  type WorkerKeyInsert,
  type WorkerKeyLookup,
  type WorkerPatch,
  type WorkflowInsert,
  type WorkflowPatch,
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
  private readonly messages = new Map<string, Owned<Message>>();
  private readonly events = new Map<string, Owned<TaskEvent>>();
  private readonly artifacts = new Map<string, Owned<Artifact>>();
  private readonly jobs = new Map<string, Job>();
  private readonly jobLogs = new Map<number, Owned<JobLog>>();
  private readonly workers = new Map<string, Worker>();
  private readonly workerKeys = new Map<string, WorkerKeyLookup>();
  private readonly secrets = new Map<string, StoredSecret>();
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

  async deleteTask(userId: string, id: string): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t || t.userId !== userId) return false;
    for (const child of [...this.tasks.values()].filter((c) => c.parentTaskId === id)) await this.deleteTask(userId, child.id);
    this.tasks.delete(id);
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
    for (const t of this.tasks.values()) if (t.prUrl === prUrl) return clone(t);
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
      createdAt: this.now(),
    };
    this.messages.set(message.id, message);
    const { userId: _u, ...out } = message;
    return clone(out);
  }

  // ---- events ----
  async listEvents(userId: string, taskId: string): Promise<TaskEvent[]> {
    return [...this.events.values()].filter((e) => e.userId === userId && e.taskId === taskId).map(({ userId: _u, ...e }) => clone(e));
  }

  async createEvent(userId: string, input: EventInsert): Promise<TaskEvent> {
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
    const { userId: _u, ...out } = event;
    return clone(out);
  }

  // ---- artifacts ----
  async listArtifacts(userId: string, taskId: string): Promise<Artifact[]> {
    return [...this.artifacts.values()].filter((a) => a.userId === userId && a.taskId === taskId).map(({ userId: _u, ...a }) => clone(a));
  }

  async createArtifact(userId: string, input: ArtifactInsert): Promise<Artifact> {
    const artifact: Owned<Artifact> = {
      id: randomUUID(),
      userId,
      taskId: input.taskId,
      jobId: input.jobId ?? null,
      name: input.name,
      contentType: input.contentType,
      content: input.content,
      createdAt: this.now(),
    };
    this.artifacts.set(artifact.id, artifact);
    const { userId: _u, ...out } = artifact;
    return clone(out);
  }

  // ---- jobs ----
  async createJob(userId: string, input: JobInsert): Promise<Job> {
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
      createdAt: this.now(),
      claimedAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    return clone(job);
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
    return clone(j);
  }

  async claimJobs(userId: string, workerId: string, max: number): Promise<Job[]> {
    const limit = Math.max(1, Math.min(max, 10));
    const busyTasks = new Set<string>();
    for (const j of this.jobs.values()) {
      if (j.userId === userId && (j.status === 'claimed' || j.status === 'running')) busyTasks.add(j.taskId);
    }
    const claimed: Job[] = [];
    for (const j of this.jobs.values()) {
      if (claimed.length >= limit) break;
      if (j.userId !== userId || j.status !== 'queued' || busyTasks.has(j.taskId)) continue;
      j.status = 'claimed';
      j.workerId = workerId;
      j.claimedAt = this.now();
      busyTasks.add(j.taskId);
      claimed.push(clone(j));
    }
    return claimed;
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

  async listActiveJobs(): Promise<Job[]> {
    return [...this.jobs.values()].filter((j) => j.status === 'claimed' || j.status === 'running').map(clone);
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
}
