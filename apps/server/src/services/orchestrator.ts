import {
  DEFAULT_TROUBLESHOOT_STEP,
  START_EVENT,
  TransitionError,
  UNIVERSAL_EVENTS,
  chatTriggersFeedback,
  eventForResult,
  getStep,
  snapshotWorkflow,
  transition,
  type AgentResult,
  type CreateTaskInput,
  type Job,
  type JobContext,
  type Message,
  type MessageSource,
  type RebaseStackJobPayload,
  type Task,
  type TaskWithRelations,
  type Transition,
  type UpdateTaskInput,
  type Workflow,
  type WorkflowStep,
} from '@sindral/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Repository } from '../db/repository.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Hub } from '../realtime/hub.js';
import { toWorkflow, type WorkflowService } from './workflows.js';

export type Actor = 'user' | 'worker' | 'system';

interface ApplyOptions {
  actor: Actor;
  /** Replaces the chat-derived feedback in the dispatched job context (used for verify NO_GO). */
  feedbackOverride?: string;
  detail?: Record<string, unknown>;
}

export interface OrchestratorDeps {
  repo: Repository;
  hub: Hub;
  workflows: WorkflowService;
  log: FastifyBaseLogger;
  now?: () => Date;
}

export const REVIEW_ARTIFACT = 'adversarial-review.md';
export const VERIFY_ARTIFACT = 'verify-report.md';
export const STALE_JOB_AFTER_MS = 15 * 60_000;
export const WORKER_LOST_AFTER_MS = 5 * 60_000;
export const MAX_JOB_ATTEMPTS = 3;
const MIN_SUBTASKS = 2;

export function branchNameFor(key: string): string {
  return `sindral/${key.toLowerCase()}`;
}

/**
 * Drives tasks through their workflow: transitions, job dispatch, worker results,
 * subtask stacks and failure handling. All state lives in the repository; this
 * class is stateless and safe to construct per app.
 */
export class Orchestrator {
  private readonly repo: Repository;
  private readonly hub: Hub;
  private readonly workflows: WorkflowService;
  private readonly log: FastifyBaseLogger;
  private readonly now: () => Date;

  constructor(deps: OrchestratorDeps) {
    this.repo = deps.repo;
    this.hub = deps.hub;
    this.workflows = deps.workflows;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- tasks

  async createTask(userId: string, input: CreateTaskInput): Promise<Task> {
    let workflowId: string | null;
    if (input.workflowId) {
      const wf = await this.workflows.get(userId, input.workflowId);
      if (!wf) throw badRequest('Unknown workflow');
      workflowId = wf.id;
    } else {
      workflowId = (await this.workflows.getDefault(userId))?.id ?? null;
    }
    const key = input.key ?? `SIN-${await this.repo.nextTaskNumber(userId)}`;
    const task = await this.repo.createTask(userId, {
      key,
      title: input.title,
      description: input.description,
      state: 'todo',
      currentStepId: null,
      workflowId,
      pinnedWorkflow: null,
      repos: input.repos,
      ticketUrl: input.ticketUrl ?? null,
      branch: input.repos.length > 0 ? branchNameFor(key) : null,
      baseBranch: null,
      parentTaskId: null,
      sequence: null,
    });
    await this.repo.createEvent(userId, { taskId: task.id, type: 'created', toState: task.state, detail: { actor: 'user' } });
    this.hub.publish(userId, { type: 'task.created', taskId: task.id });
    return task;
  }

  async getTask(userId: string, id: string): Promise<Task> {
    const task = await this.repo.getTask(userId, id);
    if (!task) throw notFound('Task');
    return task;
  }

  async getTaskWithRelations(userId: string, id: string): Promise<TaskWithRelations> {
    const task = await this.getTask(userId, id);
    const [messages, events, artifacts, subtasks] = await Promise.all([
      this.repo.listMessages(userId, id),
      this.repo.listEvents(userId, id),
      this.repo.listArtifacts(userId, id),
      this.repo.listSubtasks(userId, id),
    ]);
    return { ...task, messages, events, artifacts, subtasks };
  }

  async updateTask(userId: string, id: string, patch: UpdateTaskInput): Promise<Task> {
    const task = await this.getTask(userId, id);
    const changes: Parameters<Repository['updateTask']>[2] = {};
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.repos !== undefined || patch.workflowId !== undefined) {
      if (task.state !== 'todo') throw conflict('Repositories and workflow can only be changed while the task is in todo');
      if (patch.repos !== undefined) {
        changes.repos = patch.repos;
        changes.branch = patch.repos.length > 0 ? (task.branch ?? branchNameFor(task.key)) : null;
      }
      if (patch.workflowId !== undefined) {
        if (patch.workflowId === null) changes.workflowId = null;
        else {
          const wf = await this.workflows.get(userId, patch.workflowId);
          if (!wf) throw badRequest('Unknown workflow');
          changes.workflowId = wf.id;
        }
      }
    }
    const updated = await this.repo.updateTask(userId, id, changes);
    if (!updated) throw notFound('Task');
    this.hub.publish(userId, { type: 'task.updated', taskId: id });
    return updated;
  }

  async deleteTask(userId: string, id: string): Promise<void> {
    await this.getTask(userId, id);
    await this.repo.cancelQueuedJobs(userId, id);
    for (const child of await this.repo.listSubtasks(userId, id)) await this.repo.cancelQueuedJobs(userId, child.id);
    await this.repo.deleteTask(userId, id);
    this.hub.publish(userId, { type: 'task.deleted', taskId: id });
  }

  /** The workflow governing a task: the pinned snapshot once started, otherwise the live workflow. */
  async resolveWorkflow(userId: string, task: Task): Promise<Workflow | null> {
    if (task.pinnedWorkflow) return task.pinnedWorkflow;
    if (!task.workflowId) return null;
    const live = await this.workflows.get(userId, task.workflowId);
    return live ? toWorkflow(live) : null;
  }

  // ---------------------------------------------------------------- events & messages

  async applyUserEvent(userId: string, taskId: string, event: string): Promise<Task> {
    const task = await this.getTask(userId, taskId);
    return this.applyEvent(userId, task, event, { actor: 'user' });
  }

  /** Stores a user message; on human steps with a `feedback` edge this dispatches the revision agent. */
  async postUserMessage(
    userId: string,
    taskId: string,
    content: string,
    source: MessageSource,
    externalId?: string,
  ): Promise<{ message: Message | null; task: Task }> {
    let task = await this.getTask(userId, taskId);
    const message = await this.repo.createMessage(userId, { taskId, role: 'user', content, source, externalId: externalId ?? null });
    if (!message) return { message: null, task };
    const workflow = await this.resolveWorkflow(userId, task);
    if (workflow && chatTriggersFeedback(task, workflow)) {
      task = await this.applyEvent(userId, task, 'feedback', { actor: 'user', detail: { source } });
    } else {
      this.hub.publish(userId, { type: 'task.updated', taskId });
    }
    return { message, task };
  }

  private async applyEvent(userId: string, task: Task, event: string, options: ApplyOptions): Promise<Task> {
    const live = await this.resolveWorkflow(userId, task);
    if (!live) throw new TransitionError('Task has no workflow', 'NO_WORKFLOW');
    const pinNow = task.pinnedWorkflow === null;
    const workflow = pinNow ? snapshotWorkflow(live) : live;

    const t: Transition = transition(task, workflow, event);
    const patch: Parameters<Repository['updateTask']>[2] = { state: t.nextState, currentStepId: t.nextStepId, failedStepId: t.failedStepId };
    if (pinNow) patch.pinnedWorkflow = workflow;
    const updated = await this.repo.updateTask(userId, task.id, patch);
    if (!updated) throw notFound('Task');

    await this.repo.createEvent(userId, {
      taskId: task.id,
      type: 'transition',
      fromState: task.state,
      toState: t.nextState,
      stepId: t.nextStepId,
      detail: { event, actor: options.actor, ...(options.detail ?? {}) },
    });
    if (event === UNIVERSAL_EVENTS.FAIL) await this.repo.cancelQueuedJobs(userId, task.id);

    let current = updated;
    for (const effect of t.effects) {
      switch (effect.type) {
        case 'dispatch':
          current = await this.handleDispatch(userId, current, workflow, effect.stepId, options.feedbackOverride);
          break;
        case 'dispatch-troubleshoot':
          await this.enqueueAgentJob(userId, current, workflow.troubleshootStep ?? DEFAULT_TROUBLESHOOT_STEP, options.feedbackOverride);
          break;
        case 'complete-task':
          await this.onTaskCompleted(userId, current);
          break;
      }
    }
    if (current.parentTaskId && this.isReviewOrDone(current, workflow)) await this.startNextSibling(userId, current);

    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    return (await this.repo.getTask(userId, task.id)) ?? current;
  }

  private isReviewOrDone(task: Task, workflow: Workflow): boolean {
    if (task.state === 'done') return true;
    const step = getStep(workflow, task.currentStepId);
    return step?.type === 'human' && task.state === 'in-review';
  }

  // ---------------------------------------------------------------- dispatch

  private async handleDispatch(userId: string, task: Task, workflow: Workflow, stepId: string, feedbackOverride?: string): Promise<Task> {
    const step = getStep(workflow, stepId);
    if (!step) throw new TransitionError(`Unknown step ${stepId}`, 'NO_STEP');

    // A parent whose plan produced subtasks does not implement anything itself:
    // the first child is started instead and the parent waits on the stack.
    if (step.output === 'pr' && task.parentTaskId === null) {
      const children = await this.repo.listSubtasks(userId, task.id);
      if (children.length > 0) {
        await this.repo.createEvent(userId, { taskId: task.id, type: 'subtasks-started', stepId: step.id, detail: { count: children.length } });
        const first = children[0]!;
        if (first.state === 'todo') await this.applyEvent(userId, first, START_EVENT, { actor: 'system', detail: { reason: 'parent-implement' } });
        else if (children.every((c) => c.state === 'done')) await this.completeParent(userId, task);
        return (await this.repo.getTask(userId, task.id)) ?? task;
      }
    }
    await this.enqueueAgentJob(userId, task, step, feedbackOverride);
    return task;
  }

  private async enqueueAgentJob(userId: string, task: Task, step: WorkflowStep, feedbackOverride?: string): Promise<Job> {
    const context = await this.buildJobContext(userId, task, feedbackOverride);
    const job = await this.repo.createJob(userId, {
      taskId: task.id,
      kind: 'agent',
      stepId: step.id,
      payload: { kind: 'agent', step, context, repos: task.repos, branch: task.branch, baseBranch: task.baseBranch, prUrl: task.prUrl },
    });
    await this.repo.createEvent(userId, { taskId: task.id, type: 'job-queued', stepId: step.id, detail: { jobId: job.id, kind: 'agent' } });
    return job;
  }

  async buildJobContext(userId: string, task: Task, feedbackOverride?: string): Promise<JobContext> {
    const [messages, artifacts] = await Promise.all([this.repo.listMessages(userId, task.id), this.repo.listArtifacts(userId, task.id)]);
    const feedback = feedbackOverride ?? feedbackSinceLastAgentMessage(messages);
    const latest = (name: string): string => {
      const matching = artifacts.filter((a) => a.name === name);
      return matching[matching.length - 1]?.content ?? '';
    };

    let parentPlan = '';
    let siblingSummaries = '';
    if (task.parentTaskId) {
      const parent = await this.repo.getTask(userId, task.parentTaskId);
      parentPlan = parent?.plan ?? '';
      const siblings = (await this.repo.listSubtasks(userId, task.parentTaskId)).filter((s) => (s.sequence ?? 0) < (task.sequence ?? 0));
      const lines: string[] = [];
      for (const sibling of siblings) {
        const summary = lastAgentSummary(await this.repo.listMessages(userId, sibling.id));
        lines.push(`- **${sibling.key} ${sibling.title}** (${sibling.state}): ${summary || 'no summary yet'}`);
      }
      siblingSummaries = lines.join('\n');
    }

    return {
      task_key: task.key,
      task_title: task.title,
      task_description: task.description,
      plan: task.plan ?? '',
      feedback,
      pr_url: task.prUrl ?? '',
      parent_plan: parentPlan,
      sibling_summaries: siblingSummaries,
      review: latest(REVIEW_ARTIFACT),
      verify_report: latest(VERIFY_ARTIFACT),
      error: task.lastError ?? '',
    };
  }

  // ---------------------------------------------------------------- worker results

  async completeJob(userId: string, jobId: string, result: AgentResult): Promise<void> {
    const job = await this.repo.getJob(userId, jobId);
    if (!job) throw notFound('Job');
    if (job.status !== 'claimed' && job.status !== 'running') throw conflict(`Job is ${job.status}`);
    const expectedKind = job.kind === 'rebase-stack' ? 'rebase' : job.payload.kind === 'agent' ? job.payload.step.output : null;
    if (expectedKind !== result.kind) throw badRequest(`Job expects a "${expectedKind}" result, received "${result.kind}"`);

    const task = await this.repo.getTask(userId, job.taskId);
    if (!task) throw notFound('Task');
    await this.repo.updateJob(userId, job.id, { status: 'completed', result, finishedAt: this.now().toISOString() });

    if (result.kind === 'rebase') {
      await this.applyRebaseResult(userId, job, task, result);
      return;
    }

    let current = await this.applyResult(userId, job, task, result);
    await this.repo.createMessage(userId, { taskId: task.id, role: 'agent', content: result.summary, source: 'worker' });

    if (this.isJobCurrent(current, job)) {
      const feedbackOverride = result.kind === 'verdict' && result.verdict === 'NO_GO' ? (result.feedback ?? result.summary) : undefined;
      current = await this.applyEvent(userId, current, eventForResult(result), { actor: 'worker', feedbackOverride, detail: { jobId: job.id } });
    } else {
      this.log.warn({ jobId: job.id, taskId: task.id }, 'job result arrived for a task that has moved on; stored without transition');
      await this.repo.createEvent(userId, { taskId: task.id, type: 'stale-result', stepId: job.stepId, detail: { jobId: job.id } });
    }
    if (result.kind === 'pr' && current.parentTaskId) await this.enqueueStackRebase(userId, current);
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
  }

  async failJob(userId: string, jobId: string, error: string): Promise<void> {
    const job = await this.repo.getJob(userId, jobId);
    if (!job) throw notFound('Job');
    if (job.status !== 'claimed' && job.status !== 'running') throw conflict(`Job is ${job.status}`);
    await this.repo.updateJob(userId, job.id, { status: 'failed', error, finishedAt: this.now().toISOString() });
    const task = await this.repo.getTask(userId, job.taskId);
    if (!task) throw notFound('Task');
    await this.failTask(userId, task, job, error);
  }

  private async failTask(userId: string, task: Task, job: Job, error: string): Promise<void> {
    await this.repo.updateTask(userId, task.id, { lastError: error });
    const label = job.payload.kind === 'agent' ? job.payload.step.label : 'Stack rebase';
    await this.repo.createMessage(userId, { taskId: task.id, role: 'agent', content: `${label} failed: ${error}`, source: 'worker' });
    if (job.kind === 'agent' && task.state !== 'failure' && this.isJobCurrent(task, job)) {
      const fresh = (await this.repo.getTask(userId, task.id)) ?? task;
      await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.FAIL, { actor: 'worker', detail: { jobId: job.id } });
    } else {
      this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    }
  }

  /** Whether the task is still positioned on the step this job was dispatched for. */
  private isJobCurrent(task: Task, job: Job): boolean {
    if (job.payload.kind !== 'agent') return false;
    const step = job.payload.step;
    if (step.output === 'troubleshoot') return task.state === 'troubleshoot';
    return task.currentStepId === step.id && task.state === step.state;
  }

  private async applyResult(userId: string, job: Job, task: Task, result: Exclude<AgentResult, { kind: 'rebase' }>): Promise<Task> {
    switch (result.kind) {
      case 'plan': {
        const updated = await this.repo.updateTask(userId, task.id, { plan: result.plan });
        if (result.subtasks && result.subtasks.length >= MIN_SUBTASKS && task.parentTaskId === null) {
          await this.createSubtasks(userId, updated ?? task, result.subtasks);
        }
        return updated ?? task;
      }
      case 'pr':
        return (await this.repo.updateTask(userId, task.id, { prUrl: result.prUrl, branch: result.branch || task.branch })) ?? task;
      case 'review':
        await this.repo.createArtifact(userId, { taskId: task.id, jobId: job.id, name: REVIEW_ARTIFACT, contentType: 'text/markdown', content: result.report });
        return task;
      case 'verdict':
        await this.repo.createArtifact(userId, { taskId: task.id, jobId: job.id, name: VERIFY_ARTIFACT, contentType: 'text/markdown', content: result.report });
        return task;
      case 'document':
        for (const artifact of result.artifacts) {
          await this.repo.createArtifact(userId, { taskId: task.id, jobId: job.id, name: artifact.name, contentType: artifact.contentType, content: artifact.content });
        }
        return task;
      case 'troubleshoot':
        await this.repo.createMessage(userId, { taskId: task.id, role: 'agent', content: result.diagnosis, source: 'worker' });
        return task;
    }
  }

  // ---------------------------------------------------------------- subtasks

  private async createSubtasks(userId: string, parent: Task, subtasks: { title: string; goal: string }[]): Promise<void> {
    // Re-planning after children exist would duplicate the stack; keep the first one.
    if ((await this.repo.listSubtasks(userId, parent.id)).length > 0) return;
    let previousBranch: string | null = null;
    for (const [index, sub] of subtasks.entries()) {
      const key = `SIN-${await this.repo.nextTaskNumber(userId)}`;
      const branch = parent.repos.length > 0 ? branchNameFor(key) : null;
      const child = await this.repo.createTask(userId, {
        key,
        title: sub.title,
        description: sub.goal,
        state: 'todo',
        currentStepId: null,
        workflowId: parent.workflowId,
        pinnedWorkflow: parent.pinnedWorkflow,
        repos: parent.repos,
        ticketUrl: null,
        branch,
        baseBranch: previousBranch,
        parentTaskId: parent.id,
        sequence: index + 1,
      });
      await this.repo.createEvent(userId, { taskId: child.id, type: 'created', toState: 'todo', detail: { actor: 'system', parentTaskId: parent.id } });
      this.hub.publish(userId, { type: 'task.created', taskId: child.id });
      previousBranch = branch;
    }
    await this.repo.createEvent(userId, { taskId: parent.id, type: 'subtasks-created', detail: { count: subtasks.length } });
  }

  private async startNextSibling(userId: string, child: Task): Promise<void> {
    if (!child.parentTaskId || child.sequence === null) return;
    const siblings = await this.repo.listSubtasks(userId, child.parentTaskId);
    const next = siblings.find((s) => s.sequence === child.sequence! + 1);
    if (next && next.state === 'todo') {
      await this.applyEvent(userId, next, START_EVENT, { actor: 'system', detail: { reason: 'previous-subtask-in-review', previous: child.id } });
    }
  }

  private async onTaskCompleted(userId: string, task: Task): Promise<void> {
    if (!task.parentTaskId) return;
    const siblings = await this.repo.listSubtasks(userId, task.parentTaskId);
    if (!siblings.every((s) => s.state === 'done')) return;
    const parent = await this.repo.getTask(userId, task.parentTaskId);
    if (parent && parent.state !== 'done') await this.completeParent(userId, parent);
  }

  private async completeParent(userId: string, parent: Task): Promise<void> {
    const workflow = await this.resolveWorkflow(userId, parent);
    const endStep = workflow?.steps.find((s) => s.type === 'end') ?? null;
    await this.repo.updateTask(userId, parent.id, { state: 'done', currentStepId: endStep?.id ?? parent.currentStepId, failedStepId: null });
    await this.repo.createEvent(userId, {
      taskId: parent.id,
      type: 'subtasks-complete',
      fromState: parent.state,
      toState: 'done',
      stepId: endStep?.id ?? null,
      detail: { actor: 'system' },
    });
    this.hub.publish(userId, { type: 'task.updated', taskId: parent.id });
  }

  /** After a child pushes a PR, later siblings that already have PRs must be rebased on top of it. */
  private async enqueueStackRebase(userId: string, child: Task): Promise<Job | null> {
    if (!child.parentTaskId || child.sequence === null || !child.branch) return null;
    const siblings = await this.repo.listSubtasks(userId, child.parentTaskId);
    const later = siblings.filter((s) => (s.sequence ?? 0) > child.sequence! && s.prUrl && s.branch);
    if (later.length === 0) return null;
    let previous = child.branch;
    const stack: RebaseStackJobPayload['stack'] = [];
    for (const sibling of later) {
      stack.push({ taskId: sibling.id, branch: sibling.branch!, baseBranch: sibling.baseBranch ?? previous });
      previous = sibling.branch!;
    }
    const job = await this.repo.createJob(userId, {
      taskId: child.parentTaskId,
      kind: 'rebase-stack',
      stepId: null,
      payload: { kind: 'rebase-stack', repos: child.repos, stack },
    });
    await this.repo.createEvent(userId, { taskId: child.parentTaskId, type: 'job-queued', detail: { jobId: job.id, kind: 'rebase-stack', trigger: child.id } });
    this.hub.publish(userId, { type: 'task.updated', taskId: child.parentTaskId });
    return job;
  }

  private async applyRebaseResult(userId: string, job: Job, parent: Task, result: Extract<AgentResult, { kind: 'rebase' }>): Promise<void> {
    await this.repo.createMessage(userId, { taskId: parent.id, role: 'agent', content: result.summary, source: 'worker' });
    for (const entry of result.rebased) {
      if (entry.ok) continue;
      const sibling = await this.repo.getTask(userId, entry.taskId);
      if (!sibling || sibling.parentTaskId !== parent.id) continue;
      const error = entry.error ?? `Rebase of ${entry.branch} failed`;
      await this.repo.updateTask(userId, sibling.id, { lastError: error });
      await this.repo.createMessage(userId, { taskId: sibling.id, role: 'agent', content: `Stack rebase failed: ${error}`, source: 'worker' });
      if (sibling.state !== 'failure' && sibling.state !== 'done') {
        const fresh = (await this.repo.getTask(userId, sibling.id)) ?? sibling;
        await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.FAIL, { actor: 'system', detail: { jobId: job.id, reason: 'rebase' } });
      }
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: parent.id });
  }

  // ---------------------------------------------------------------- sweeper

  /** Requeue (or fail) jobs whose worker disappeared. Runs periodically from the app. */
  async sweepStaleJobs(now: Date = this.now()): Promise<{ requeued: number; failed: number }> {
    const cutoff = now.getTime() - STALE_JOB_AFTER_MS;
    const lostCutoff = now.getTime() - WORKER_LOST_AFTER_MS;
    let requeued = 0;
    let failed = 0;
    for (const job of await this.repo.listActiveJobs()) {
      const claimedAt = job.claimedAt ? Date.parse(job.claimedAt) : 0;
      if (claimedAt > cutoff) continue;
      const worker = job.workerId ? await this.repo.getWorker(job.userId, job.workerId) : null;
      if (worker && Date.parse(worker.lastSeenAt) > lostCutoff) continue;
      if (job.attempt < MAX_JOB_ATTEMPTS) {
        await this.repo.updateJob(job.userId, job.id, { status: 'queued', workerId: null, claimedAt: null, attempt: job.attempt + 1 });
        requeued += 1;
        this.log.warn({ jobId: job.id, attempt: job.attempt + 1 }, 'requeued job from lost worker');
      } else {
        const error = 'Worker stopped responding and the job exhausted its retries';
        await this.repo.updateJob(job.userId, job.id, { status: 'failed', error, finishedAt: now.toISOString() });
        const task = await this.repo.getTask(job.userId, job.taskId);
        if (task) await this.failTask(job.userId, task, job, error);
        failed += 1;
      }
    }
    return { requeued, failed };
  }
}

/** User messages posted after the most recent agent message, joined with blank lines. */
export function feedbackSinceLastAgentMessage(messages: Message[]): string {
  let lastAgent = -1;
  messages.forEach((m, i) => {
    if (m.role === 'agent') lastAgent = i;
  });
  return messages
    .slice(lastAgent + 1)
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');
}

function lastAgentSummary(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'agent') return m.content;
  }
  return '';
}
