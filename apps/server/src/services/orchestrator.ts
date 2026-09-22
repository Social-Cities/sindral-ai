import { createHash } from 'node:crypto';
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
  type GitHubFeedbackReference,
  type Message,
  type MessageSource,
  type ResolveRebaseConflictJobPayload,
  type RebaseStackJobPayload,
  type Task,
  type TaskWithRelations,
  type Transition,
  type UpdateTaskInput,
  type Workflow,
  type WorkflowStep,
} from '@sindral/shared';
import type { FastifyBaseLogger } from 'fastify';
import { ConflictError, type JobOutcomeClaim, type Repository } from '../db/repository.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../errors.js';
import type { Hub } from '../realtime/hub.js';
import { parsePrUrl } from './github.js';
import { toWorkflow, type WorkflowService } from './workflows.js';

export type Actor = 'user' | 'worker' | 'system';

interface ApplyOptions {
  actor: Actor;
  idempotencyKey?: string;
  expectedVersion?: number;
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
export const CONFLICT_PROMPT_VERSION = 'rebase-conflict-v1';
export const STALE_JOB_AFTER_MS = 15 * 60_000;
export const WORKER_LOST_AFTER_MS = 5 * 60_000;
export const OUTCOME_LEASE_MS = 30_000;
export const MAX_JOB_ATTEMPTS = 3;
const MIN_SUBTASKS = 2;
const DEFAULT_CONFLICT_PROTECTED_PATHS = [
  'supabase/migrations/',
  '.github/workflows/',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Dockerfile',
  '.env',
];

function transitionRequestHash(
  userId: string,
  taskId: string,
  expectedVersion: number,
  event: string,
  actor: Actor,
  detail: Record<string, unknown> | undefined,
): string {
  return createHash('sha256').update(JSON.stringify({ userId, taskId, expectedVersion, event, actor, detail: detail ?? null })).digest('hex');
}

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
    await this.syncTaskRepositories(userId, task);
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
    const [messages, events, artifacts, subtasks, repositories, pullRequests] = await Promise.all([
      this.repo.listMessages(userId, id),
      this.repo.listEvents(userId, id),
      this.repo.listArtifacts(userId, id),
      this.repo.listSubtasks(userId, id),
      this.repo.listTaskRepositories(userId, id),
      this.repo.listPullRequests(userId, id),
    ]);
    return { ...task, messages, events, artifacts, subtasks, repositories, pullRequests };
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
    if (patch.repos !== undefined) await this.syncTaskRepositories(userId, updated);
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

  async applyUserEvent(userId: string, taskId: string, event: string, expectedVersion?: number, idempotencyKey?: string): Promise<Task> {
    const task = await this.getTask(userId, taskId);
    const version = expectedVersion ?? task.version;
    const key = idempotencyKey ?? `direct:${task.id}:${version}:${event}`;
    const replay = await this.repo.getTaskTransitionReplay(userId, key, transitionRequestHash(userId, task.id, version, event, 'user', undefined));
    if (replay) return replay.task;
    if (task.version !== version) throw conflict(`Task version ${version} is stale; current version is ${task.version}`);
    return this.applyEvent(userId, task, event, {
      actor: 'user',
      expectedVersion: version,
      idempotencyKey: key,
    });
  }

  /** Stores a user message; on human steps with a `feedback` edge this dispatches the revision agent. */
  async postUserMessage(
    userId: string,
    taskId: string,
    content: string,
    source: MessageSource,
    externalId?: string,
    githubFeedback?: GitHubFeedbackReference,
  ): Promise<{ message: Message | null; task: Task }> {
    let task = await this.getTask(userId, taskId);
    const message = await this.repo.createMessage(userId, {
      taskId,
      role: 'user',
      content,
      source,
      externalId: externalId ?? null,
      githubFeedback: githubFeedback ?? null,
    });
    const workflow = await this.resolveWorkflow(userId, task);
    if (workflow && chatTriggersFeedback(task, workflow)) {
      task = await this.applyEvent(userId, task, 'feedback', {
        actor: 'user',
        detail: { source },
        ...(externalId ? { idempotencyKey: `message:${source}:${task.id}:${externalId}:feedback` } : {}),
      });
    } else if (message) {
      this.hub.publish(userId, { type: 'task.updated', taskId });
    }
    return { message, task };
  }

  private async applyEvent(userId: string, task: Task, event: string, options: ApplyOptions): Promise<Task> {
    if (options.idempotencyKey) {
      const replay = await this.repo.getTaskTransitionReplayByKey(userId, options.idempotencyKey);
      if (replay) return replay.task;
    }
    const live = await this.resolveWorkflow(userId, task);
    if (!live) throw new TransitionError('Task has no workflow', 'NO_WORKFLOW');
    const pinNow = task.pinnedWorkflow === null;
    const workflow = pinNow ? snapshotWorkflow(live) : live;

    const t: Transition = transition(task, workflow, event);
    const patch: Parameters<Repository['applyTaskTransition']>[1]['patch'] = {
      state: t.nextState,
      currentStepId: t.nextStepId,
      failedStepId: t.failedStepId,
    };
    if (pinNow) patch.pinnedWorkflow = workflow;
    let queuedJob: Parameters<Repository['createJob']>[1] | undefined;
    let parentDispatchStepId: string | null = null;
    for (const effect of t.effects) {
      if (effect.type === 'dispatch') {
        const step = getStep(workflow, effect.stepId);
        if (!step) throw new TransitionError(`Unknown step ${effect.stepId}`, 'NO_STEP');
        if (step.output === 'merge') queuedJob = await this.buildMergeJob(userId, task, step.id);
        else if (step.output === 'pr' && task.parentTaskId === null && (await this.repo.listSubtasks(userId, task.id)).length > 0) {
          parentDispatchStepId = step.id;
        } else queuedJob = await this.buildAgentJob(userId, task, step, options.feedbackOverride);
      } else if (effect.type === 'dispatch-troubleshoot') {
        queuedJob = await this.buildAgentJob(userId, task, workflow.troubleshootStep ?? DEFAULT_TROUBLESHOOT_STEP, options.feedbackOverride);
      }
    }
    const expectedVersion = options.expectedVersion ?? task.version;
    const requestHash = transitionRequestHash(userId, task.id, expectedVersion, event, options.actor, options.detail);
    const applied = await this.repo.applyTaskTransition(userId, {
      taskId: task.id,
      expectedVersion,
      idempotencyKey: options.idempotencyKey ?? `transition:${task.id}:${expectedVersion}:${event}`,
      requestHash,
      patch,
      event: {
        taskId: task.id,
        type: 'transition',
        fromState: task.state,
        toState: t.nextState,
        stepId: t.nextStepId,
        detail: { event, actor: options.actor, ...(options.detail ?? {}) },
      },
      job: queuedJob,
      cancelQueuedJobs: event === UNIVERSAL_EVENTS.FAIL,
    });
    if (applied.replayed) return applied.task;

    let current = applied.task;
    for (const effect of t.effects) {
      switch (effect.type) {
        case 'dispatch':
          if (parentDispatchStepId === effect.stepId) current = await this.handleParentDispatch(userId, current, effect.stepId);
          break;
        case 'dispatch-troubleshoot':
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

  private async handleParentDispatch(userId: string, task: Task, stepId: string): Promise<Task> {
    // A parent whose plan produced subtasks does not implement anything itself:
    // the first child is started instead and the parent waits on the stack.
    const children = await this.repo.listSubtasks(userId, task.id);
    if (children.length > 0) {
      await this.repo.createEvent(userId, { taskId: task.id, type: 'subtasks-started', stepId, detail: { count: children.length } });
      const first = children[0]!;
      if (first.state === 'todo') await this.applyEvent(userId, first, START_EVENT, { actor: 'system', detail: { reason: 'parent-implement' } });
      else if (children.every((c) => c.state === 'done')) await this.completeParent(userId, task);
    }
    return (await this.repo.getTask(userId, task.id)) ?? task;
  }

  private async buildAgentJob(
    userId: string,
    task: Task,
    step: WorkflowStep,
    feedbackOverride?: string,
  ): Promise<Parameters<Repository['createJob']>[1]> {
    const context = await this.buildJobContext(userId, task, feedbackOverride);
    return {
      taskId: task.id,
      kind: 'agent',
      stepId: step.id,
      payload: { kind: 'agent', step, context, repos: task.repos, branch: task.branch, baseBranch: task.baseBranch, prUrl: task.prUrl },
    };
  }

  private async buildMergeJob(userId: string, task: Task, stepId: string): Promise<Parameters<Repository['createJob']>[1]> {
    const [repositories, pullRequests] = await Promise.all([
      this.repo.listTaskRepositories(userId, task.id),
      this.repo.listPullRequests(userId, task.id),
    ]);
    if (pullRequests.length === 0) throw conflict('No pull requests are available to merge');
    const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
    const items = pullRequests.map((pullRequest) => {
      const repository = repositoryById.get(pullRequest.taskRepositoryId);
      if (!repository) throw conflict(`Pull request ${pullRequest.url} has no repository record`);
      if (!pullRequest.headSha) throw conflict(`Pull request ${pullRequest.url} has no pinned head commit`);
      return {
        id: pullRequest.id,
        repository: pullRequest.repository,
        url: pullRequest.url,
        number: pullRequest.number,
        headSha: pullRequest.headSha,
        method: repository.mergeMethod,
      };
    });
    return {
      taskId: task.id,
      kind: 'merge-pull-requests',
      stepId,
      payload: { kind: 'merge-pull-requests', pullRequests: items },
    };
  }

  async buildJobContext(userId: string, task: Task, feedbackOverride?: string): Promise<JobContext> {
    const [messages, artifacts] = await Promise.all([this.repo.listMessages(userId, task.id), this.repo.listArtifacts(userId, task.id)]);
    const pendingMessages = messagesSinceLastAgentMessage(messages);
    const feedback = feedbackOverride ?? pendingMessages.filter((message) => message.role === 'user').map((message) => message.content).join('\n\n');
    const githubFeedback = [...pendingMessages]
      .reverse()
      .find((message) => message.role === 'user' && message.source === 'github' && message.githubFeedback)?.githubFeedback;
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
      ...(githubFeedback ? { github_feedback: githubFeedback } : {}),
    };
  }

  // ---------------------------------------------------------------- worker results

  async completeJob(userId: string, jobId: string, result: AgentResult, expectedAttempt?: number): Promise<void> {
    const job = await this.repo.getJob(userId, jobId);
    if (!job) throw notFound('Job');
    if (expectedAttempt === undefined && job.attempt > 1) throw conflict('Job attempt number is required after a retry');
    if (expectedAttempt !== undefined && job.attempt !== expectedAttempt) throw conflict(`Job attempt ${expectedAttempt} has been superseded`);
    const expectedKind =
      job.kind === 'rebase-stack'
        ? 'rebase'
        : job.kind === 'resolve-rebase-conflict'
          ? 'conflict-resolution'
          : job.kind === 'merge-pull-requests'
            ? 'merge'
          : job.payload.kind === 'agent'
            ? job.payload.step.output
            : null;
    if (expectedKind !== result.kind) throw badRequest(`Job expects a "${expectedKind}" result, received "${result.kind}"`);

    const task = await this.repo.getTask(userId, job.taskId);
    if (!task) throw notFound('Task');
    const attempt = expectedAttempt ?? job.attempt;
    const outcomeHash = this.jobOutcomeHash({ result });
    const claim = await this.beginJobOutcome(userId, job.id, attempt, outcomeHash, { result });
    if (claim.state === 'replay') return;
    if (claim.state === 'busy' || !claim.token) throw serviceUnavailable('Job outcome is already being applied; retry shortly');
    try {
      if (result.kind === 'rebase') await this.applyRebaseResult(userId, claim.job, task, result);
      else if (result.kind === 'conflict-resolution') await this.applyConflictResolutionResult(userId, claim.job, task, result);
      else if (result.kind === 'merge') await this.applyMergeResult(userId, claim.job, task, result);
      else {
        let current = await this.applyResult(userId, claim.job, task, result);
        await this.repo.createMessage(userId, {
          taskId: task.id,
          role: 'agent',
          content: result.summary,
          source: 'worker',
          externalId: `job:${job.id}:summary`,
        });

        const transitionKey = `job:${job.id}:attempt:${attempt}:transition`;
        const transitionReplay = await this.repo.getTaskTransitionReplayByKey(userId, transitionKey);
        if (transitionReplay) {
          current = transitionReplay.task;
        } else if (this.isJobCurrent(current, claim.job)) {
          const feedbackOverride = result.kind === 'verdict' && result.verdict === 'NO_GO' ? (result.feedback ?? result.summary) : undefined;
          current = await this.applyEvent(userId, current, eventForResult(result), {
            actor: 'worker',
            feedbackOverride,
            detail: { jobId: job.id },
            idempotencyKey: transitionKey,
          });
        } else {
          this.log.warn({ jobId: job.id, taskId: task.id }, 'job result arrived for a task that has moved on; stored without transition');
          await this.repo.createEvent(userId, {
            taskId: task.id,
            type: 'stale-result',
            stepId: job.stepId,
            detail: { jobId: job.id },
            dedupeKey: `job:${job.id}:stale-result`,
          });
        }
        if (result.kind === 'pr' && current.parentTaskId) await this.enqueueStackRebase(userId, current, `job:${job.id}:stack-rebase`);
        this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
      }
      await this.repo.finalizeJobOutcome(userId, job.id, attempt, outcomeHash, claim.token, 'completed');
    } catch (error) {
      await this.repo.abandonJobOutcome(userId, job.id, attempt, outcomeHash, claim.token);
      throw error;
    }
  }

  async failJob(userId: string, jobId: string, error: string, expectedAttempt?: number): Promise<void> {
    const job = await this.repo.getJob(userId, jobId);
    if (!job) throw notFound('Job');
    if (expectedAttempt === undefined && job.attempt > 1) throw conflict('Job attempt number is required after a retry');
    if (expectedAttempt !== undefined && job.attempt !== expectedAttempt) throw conflict(`Job attempt ${expectedAttempt} has been superseded`);
    const task = await this.repo.getTask(userId, job.taskId);
    if (!task) throw notFound('Task');
    const attempt = expectedAttempt ?? job.attempt;
    const outcomeHash = this.jobOutcomeHash({ error });
    const claim = await this.beginJobOutcome(userId, job.id, attempt, outcomeHash, { error });
    if (claim.state === 'replay') return;
    if (claim.state === 'busy' || !claim.token) throw serviceUnavailable('Job outcome is already being applied; retry shortly');
    try {
      await this.failTask(userId, task, claim.job, error, attempt);
      await this.repo.finalizeJobOutcome(userId, job.id, attempt, outcomeHash, claim.token, 'failed');
    } catch (cause) {
      await this.repo.abandonJobOutcome(userId, job.id, attempt, outcomeHash, claim.token);
      throw cause;
    }
  }

  private async failTask(userId: string, task: Task, job: Job, error: string, attempt = job.attempt): Promise<void> {
    await this.repo.updateTask(userId, task.id, { lastError: error });
    const label =
      job.payload.kind === 'agent'
        ? job.payload.step.label
        : job.payload.kind === 'resolve-rebase-conflict'
          ? 'Conflict resolution'
          : job.payload.kind === 'merge-pull-requests'
            ? 'Pull request merge'
            : 'Stack rebase';
    await this.repo.createMessage(userId, {
      taskId: task.id,
      role: 'agent',
      content: `${label} failed: ${error}`,
      source: 'worker',
      externalId: `job:${job.id}:failure`,
    });
    if (job.kind === 'resolve-rebase-conflict' && task.state === 'conflict-resolution') {
      const fresh = (await this.repo.getTask(userId, task.id)) ?? task;
      await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.CONFLICT_ESCALATED, {
        actor: 'worker',
        detail: { jobId: job.id },
        idempotencyKey: `job:${job.id}:attempt:${attempt}:failure-transition`,
      });
    } else if (
      ((job.kind === 'agent' && this.isJobCurrent(task, job)) || (job.kind === 'merge-pull-requests' && task.state === 'merge')) &&
      task.state !== 'failure'
    ) {
      const fresh = (await this.repo.getTask(userId, task.id)) ?? task;
      await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.FAIL, {
        actor: 'worker',
        detail: { jobId: job.id },
        idempotencyKey: `job:${job.id}:attempt:${attempt}:failure-transition`,
      });
    } else {
      this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    }
  }

  private jobOutcomeHash(outcome: { result: AgentResult } | { error: string }): string {
    return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
  }

  private async beginJobOutcome(
    userId: string,
    jobId: string,
    attempt: number,
    outcomeHash: string,
    outcome: { result: AgentResult; error?: never } | { error: string; result?: never },
  ): Promise<JobOutcomeClaim> {
    try {
      return await this.repo.beginJobOutcome(userId, jobId, attempt, outcomeHash, outcome);
    } catch (error) {
      if (error instanceof ConflictError) throw conflict(error.message);
      throw error;
    }
  }

  /** Whether the task is still positioned on the step this job was dispatched for. */
  private isJobCurrent(task: Task, job: Job): boolean {
    if (job.payload.kind !== 'agent') return false;
    const step = job.payload.step;
    if (step.output === 'troubleshoot') return task.state === 'troubleshoot';
    return task.currentStepId === step.id && task.state === step.state;
  }

  private async applyResult(
    userId: string,
    job: Job,
    task: Task,
    result: Exclude<AgentResult, { kind: 'rebase' | 'conflict-resolution' | 'merge' }>,
  ): Promise<Task> {
    switch (result.kind) {
      case 'plan': {
        const updated = await this.repo.updateTask(userId, task.id, { plan: result.plan });
        if (result.subtasks && result.subtasks.length >= MIN_SUBTASKS && task.parentTaskId === null) {
          await this.createSubtasks(userId, updated ?? task, result.subtasks, `job:${job.id}:subtasks`);
        }
        return updated ?? task;
      }
      case 'pr': {
        const pullRequests = result.pullRequests ?? [];
        if (pullRequests.length > 0) {
          const selected = new Set(task.repos);
          const returned = new Set(pullRequests.map((item) => item.repository));
          if (returned.size !== pullRequests.length || returned.size !== selected.size || [...selected].some((repository) => !returned.has(repository))) {
            throw badRequest('Pull request result must contain exactly one pull request for every selected repository');
          }
          for (const item of pullRequests) {
            const ref = parsePrUrl(item.prUrl);
            if (!ref || `${ref.owner}/${ref.repo}` !== item.repository || ref.number !== item.number) {
              throw badRequest(`Pull request URL does not match ${item.repository}#${item.number}`);
            }
            if (task.branch && item.branch !== task.branch) throw badRequest(`Pull request branch does not match task branch ${task.branch}`);
          }
          if (result.prUrl !== pullRequests[0]!.prUrl || result.branch !== pullRequests[0]!.branch) {
            throw badRequest('Legacy pull request fields do not match the first repository result');
          }
        }
        for (const item of pullRequests) {
          const repository = await this.repo.upsertTaskRepository(userId, task.id, {
            repository: item.repository,
            branch: item.branch,
            baseBranch: item.baseBranch,
          });
          await this.repo.upsertPullRequest(userId, task.id, {
            taskRepositoryId: repository.id,
            repository: item.repository,
            url: item.prUrl,
            number: item.number,
            branch: item.branch,
            baseBranch: item.baseBranch,
            headSha: item.headSha ?? null,
          });
        }
        return (await this.repo.updateTask(userId, task.id, { prUrl: result.prUrl, branch: result.branch || task.branch })) ?? task;
      }
      case 'review':
        await this.repo.createArtifact(userId, {
          taskId: task.id,
          jobId: job.id,
          name: REVIEW_ARTIFACT,
          contentType: 'text/markdown',
          content: result.report,
          dedupeKey: `job:${job.id}:artifact:${REVIEW_ARTIFACT}`,
        });
        return task;
      case 'verdict':
        await this.repo.createArtifact(userId, {
          taskId: task.id,
          jobId: job.id,
          name: VERIFY_ARTIFACT,
          contentType: 'text/markdown',
          content: result.report,
          dedupeKey: `job:${job.id}:artifact:${VERIFY_ARTIFACT}`,
        });
        return task;
      case 'document':
        for (const [index, artifact] of result.artifacts.entries()) {
          await this.repo.createArtifact(userId, {
            taskId: task.id,
            jobId: job.id,
            name: artifact.name,
            contentType: artifact.contentType,
            content: artifact.content,
            dedupeKey: `job:${job.id}:artifact:${index}`,
          });
        }
        return task;
      case 'troubleshoot':
        await this.repo.createMessage(userId, {
          taskId: task.id,
          role: 'agent',
          content: result.diagnosis,
          source: 'worker',
          externalId: `job:${job.id}:diagnosis`,
        });
        return task;
    }
  }

  // ---------------------------------------------------------------- subtasks

  private async createSubtasks(
    userId: string,
    parent: Task,
    subtasks: { title: string; goal: string }[],
    dedupePrefix?: string,
  ): Promise<void> {
    const existing = await this.repo.listSubtasks(userId, parent.id);
    if (existing.length > 0 && (await this.repo.listEvents(userId, parent.id)).some((event) => event.type === 'subtasks-created')) return;
    const existingBySequence = new Map(existing.map((child) => [child.sequence, child]));
    let previousBranch: string | null = null;
    for (const [index, sub] of subtasks.entries()) {
      const sequence = index + 1;
      const prior = existingBySequence.get(sequence);
      let child = prior;
      if (!child) {
        const key = `SIN-${await this.repo.nextTaskNumber(userId)}`;
        const branch = parent.repos.length > 0 ? branchNameFor(key) : null;
        child = await this.repo.createTask(userId, {
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
          sequence,
        });
      }
      await this.syncTaskRepositories(userId, child);
      await this.repo.createEvent(userId, {
        taskId: child.id,
        type: 'created',
        toState: 'todo',
        detail: { actor: 'system', parentTaskId: parent.id },
        dedupeKey: dedupePrefix ? `${dedupePrefix}:child:${sequence}:created` : null,
      });
      if (!prior) this.hub.publish(userId, { type: 'task.created', taskId: child.id });
      previousBranch = child.branch;
    }
    await this.repo.createEvent(userId, {
      taskId: parent.id,
      type: 'subtasks-created',
      detail: { count: subtasks.length },
      dedupeKey: dedupePrefix ? `${dedupePrefix}:created` : null,
    });
  }

  private async syncTaskRepositories(userId: string, task: Task): Promise<void> {
    if (!task.branch && task.repos.length > 0) throw new Error(`Code task ${task.id} has no branch`);
    for (const repository of task.repos) {
      await this.repo.upsertTaskRepository(userId, task.id, {
        repository,
        branch: task.branch ?? '',
        baseBranch: task.baseBranch,
      });
    }
    await this.repo.deleteTaskRepositoriesNotIn(userId, task.id, task.repos);
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
  private async enqueueStackRebase(userId: string, child: Task, dedupePrefix?: string): Promise<Job | null> {
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
    let first: Job | null = null;
    for (const repository of child.repos) {
      const job = await this.repo.createJob(userId, {
        taskId: child.parentTaskId,
        kind: 'rebase-stack',
        stepId: null,
        payload: { kind: 'rebase-stack', repos: [repository], stack },
        dedupeKey: dedupePrefix ? `${dedupePrefix}:${repository}` : null,
      });
      first ??= job;
      await this.repo.createEvent(userId, {
        taskId: child.parentTaskId,
        type: 'job-queued',
        detail: { jobId: job.id, kind: 'rebase-stack', repository, trigger: child.id },
        dedupeKey: dedupePrefix ? `${dedupePrefix}:${repository}:event` : null,
      });
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: child.parentTaskId });
    return first;
  }

  private async applyRebaseResult(userId: string, job: Job, parent: Task, result: Extract<AgentResult, { kind: 'rebase' }>): Promise<void> {
    await this.repo.createMessage(userId, {
      taskId: parent.id,
      role: 'agent',
      content: result.summary,
      source: 'worker',
      externalId: `job:${job.id}:summary`,
    });
    for (const entry of result.rebased) {
      if (entry.ok) continue;
      const sibling = await this.repo.getTask(userId, entry.taskId);
      if (!sibling || sibling.parentTaskId !== parent.id) continue;
      const error = entry.error ?? `Rebase of ${entry.branch} failed`;
      await this.repo.updateTask(userId, sibling.id, { lastError: error });
      await this.repo.createMessage(userId, {
        taskId: sibling.id,
        role: 'agent',
        content: `Stack rebase failed: ${error}`,
        source: 'worker',
        externalId: `job:${job.id}:rebase:${sibling.id}:failure`,
      });
      if (entry.conflict && sibling.state !== 'failure' && sibling.state !== 'done') {
        const resolverKey = `job:${job.id}:resolver:${sibling.id}`;
        const priorResolvers = (await this.repo.listJobsForTask(userId, sibling.id)).filter(
          (candidate) =>
            candidate.payload.kind === 'resolve-rebase-conflict' &&
            candidate.payload.sourceSha === entry.conflict!.sourceSha &&
            candidate.payload.targetSha === entry.conflict!.targetSha,
        );
        if (priorResolvers.some((candidate) => candidate.dedupeKey === resolverKey)) continue;
        const resolving = await this.applyEvent(userId, sibling, UNIVERSAL_EVENTS.REBASE_CONFLICT, {
          actor: 'system',
          detail: { jobId: job.id, repository: entry.conflict.repository, conflictedPaths: entry.conflict.conflictedPaths },
          idempotencyKey: `job:${job.id}:rebase:${sibling.id}:conflict-transition`,
        });
        const repeated = priorResolvers.length > 0;
        if (repeated) {
          const repeatedError = 'Automatic conflict resolution already attempted for this source/target commit pair';
          await this.repo.updateTask(userId, sibling.id, { lastError: repeatedError });
          await this.repo.createMessage(userId, {
            taskId: sibling.id,
            role: 'agent',
            content: repeatedError,
            source: 'worker',
            externalId: `job:${job.id}:rebase:${sibling.id}:attempt-limit`,
          });
          await this.applyEvent(userId, resolving, UNIVERSAL_EVENTS.CONFLICT_ESCALATED, {
            actor: 'system',
            detail: { jobId: job.id, reason: 'conflict-resolution-attempt-limit' },
            idempotencyKey: `job:${job.id}:rebase:${sibling.id}:escalation-transition`,
          });
          continue;
        }
        await this.enqueueConflictResolution(userId, resolving, entry.conflict, resolverKey);
        continue;
      }
      if (sibling.state !== 'failure' && sibling.state !== 'done') {
        const fresh = (await this.repo.getTask(userId, sibling.id)) ?? sibling;
        await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.FAIL, {
          actor: 'system',
          detail: { jobId: job.id, reason: 'rebase' },
          idempotencyKey: `job:${job.id}:rebase:${sibling.id}:failure-transition`,
        });
      }
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: parent.id });
  }

  private async enqueueConflictResolution(
    userId: string,
    task: Task,
    conflictInfo: NonNullable<Extract<AgentResult, { kind: 'rebase' }>['rebased'][number]['conflict']>,
    dedupeKey?: string,
  ): Promise<Job> {
    const context = await this.buildJobContext(userId, task);
    const payload: ResolveRebaseConflictJobPayload = {
      kind: 'resolve-rebase-conflict',
      repository: conflictInfo.repository,
      taskId: task.id,
      taskKey: task.key,
      branch: task.branch ?? conflictInfo.baseBranch,
      baseBranch: conflictInfo.baseBranch,
      sourceSha: conflictInfo.sourceSha,
      targetSha: conflictInfo.targetSha,
      conflictedPaths: conflictInfo.conflictedPaths,
      context,
      engine: 'claude',
      model: 'claude-opus-5',
      mode: 'high',
      policy: {
        allowedPaths: conflictInfo.conflictedPaths,
        protectedPaths: DEFAULT_CONFLICT_PROTECTED_PATHS,
        validationCommands: [],
        maxFiles: 20,
        maxChangedLines: 1_000,
      },
    };
    const job = await this.repo.createJob(userId, { taskId: task.id, kind: 'resolve-rebase-conflict', stepId: null, payload, dedupeKey });
    await this.repo.createEvent(userId, {
      taskId: task.id,
      type: 'conflict-resolution-queued',
      detail: { jobId: job.id, repository: conflictInfo.repository, branch: payload.branch, conflictedPaths: conflictInfo.conflictedPaths },
      dedupeKey: dedupeKey ? `${dedupeKey}:event` : null,
    });
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    return job;
  }

  private async applyConflictResolutionResult(
    userId: string,
    job: Job,
    task: Task,
    result: Extract<AgentResult, { kind: 'conflict-resolution' }>,
  ): Promise<void> {
    if (job.payload.kind !== 'resolve-rebase-conflict' || result.taskId !== task.id || result.branch !== job.payload.branch) {
      throw badRequest('Conflict-resolution result does not match its dispatched task and branch');
    }
    await this.repo.createMessage(userId, {
      taskId: task.id,
      role: 'agent',
      content: result.summary,
      source: 'worker',
      externalId: `job:${job.id}:summary`,
    });
    await this.repo.createEvent(userId, {
      taskId: task.id,
      type: result.resolved ? 'conflict-resolution-succeeded' : 'conflict-resolution-escalated',
      detail: {
        jobId: job.id,
        branch: result.branch,
        resolvedPaths: result.resolvedPaths,
        checks: result.checks,
        resolutionCommit: result.resolutionCommit ?? null,
        error: result.error ?? null,
      },
      dedupeKey: `job:${job.id}:conflict-resolution-event`,
    });
    await this.repo.createArtifact(userId, {
      taskId: task.id,
      jobId: job.id,
      name: `conflict-resolution-${job.id}.json`,
      contentType: 'application/json',
      content: JSON.stringify(
        {
          promptVersion: CONFLICT_PROMPT_VERSION,
          repository: job.payload.repository,
          branch: job.payload.branch,
          baseBranch: job.payload.baseBranch,
          sourceSha: job.payload.sourceSha,
          targetSha: job.payload.targetSha,
          conflictedPaths: job.payload.conflictedPaths,
          engine: job.payload.engine,
          model: job.payload.model,
          outcome: result.resolved ? 'resolved' : 'escalated',
          rationale: result.rationale,
          resolvedPaths: result.resolvedPaths,
          checks: result.checks,
          resolutionCommit: result.resolutionCommit ?? null,
          resolutionDiffHash: result.resolutionDiffHash ?? null,
          error: result.error ?? null,
        },
        null,
        2,
      ),
      dedupeKey: `job:${job.id}:conflict-resolution-artifact`,
    });
    if (result.resolved) {
      const resumed = await this.applyEvent(userId, task, UNIVERSAL_EVENTS.CONFLICT_RESOLVED, {
        actor: 'worker',
        detail: { jobId: job.id },
        idempotencyKey: `job:${job.id}:resolution-transition`,
      });
      const updated = (await this.repo.updateTask(userId, task.id, { lastError: null })) ?? resumed;
      if (updated.parentTaskId) await this.enqueueStackRebase(userId, updated, `job:${job.id}:resolved-stack-rebase`);
    } else if (task.state === 'conflict-resolution') {
      const error = result.error ?? 'Automatic conflict resolution requires human review';
      await this.repo.updateTask(userId, task.id, { lastError: error });
      const fresh = (await this.repo.getTask(userId, task.id)) ?? task;
      await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.CONFLICT_ESCALATED, {
        actor: 'system',
        detail: { jobId: job.id, reason: 'conflict-resolution' },
        idempotencyKey: `job:${job.id}:escalation-transition`,
      });
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
  }

  private async applyMergeResult(userId: string, job: Job, task: Task, result: Extract<AgentResult, { kind: 'merge' }>): Promise<void> {
    if (job.payload.kind !== 'merge-pull-requests') throw badRequest('Merge result does not match its dispatched job');
    const tracked = await this.repo.listPullRequests(userId, task.id);
    const trackedById = new Map(tracked.map((pullRequest) => [pullRequest.id, pullRequest]));
    const dispatchedIds = new Set(job.payload.pullRequests.map((pullRequest) => pullRequest.id));
    const resultIds = new Set(result.pullRequests.map((pullRequest) => pullRequest.id));
    if (
      result.pullRequests.length !== job.payload.pullRequests.length ||
      resultIds.size !== dispatchedIds.size ||
      [...dispatchedIds].some((id) => !resultIds.has(id)) ||
      result.pullRequests.some((item) => {
        const trackedPullRequest = trackedById.get(item.id);
        return !trackedPullRequest || item.repository !== trackedPullRequest.repository || item.url !== trackedPullRequest.url;
      })
    ) {
      throw badRequest('Merge result does not match its dispatched pull requests');
    }

    for (const item of result.pullRequests) {
      if (!item.merged) continue;
      const pullRequest = trackedById.get(item.id)!;
      await this.repo.upsertPullRequest(userId, task.id, {
        taskRepositoryId: pullRequest.taskRepositoryId,
        repository: pullRequest.repository,
        url: pullRequest.url,
        number: pullRequest.number,
        branch: pullRequest.branch,
        baseBranch: pullRequest.baseBranch,
        headSha: pullRequest.headSha,
        status: 'merged',
        mergedAt: pullRequest.mergedAt ?? item.mergedAt ?? this.now().toISOString(),
      });
    }

    await this.repo.createMessage(userId, {
      taskId: task.id,
      role: 'agent',
      content: result.summary,
      source: 'worker',
      externalId: `job:${job.id}:summary`,
    });
    const persisted = await this.repo.listPullRequests(userId, task.id);
    const fullyMerged = result.complete && persisted.length === dispatchedIds.size && persisted.every((pullRequest) => pullRequest.status === 'merged');
    await this.repo.createEvent(userId, {
      taskId: task.id,
      type: fullyMerged ? 'merge-complete' : 'merge-partial-failure',
      stepId: job.stepId,
      detail: { jobId: job.id, pullRequests: result.pullRequests },
      dedupeKey: `job:${job.id}:merge-result`,
    });
    if (fullyMerged && task.state === 'merge') {
      await this.applyEvent(userId, task, 'complete', {
        actor: 'worker',
        detail: { jobId: job.id },
        idempotencyKey: `job:${job.id}:merge-transition`,
      });
    } else if (task.state === 'merge') {
      const error = result.pullRequests.find((pullRequest) => !pullRequest.merged)?.error ?? 'Not every pull request could be merged';
      await this.repo.updateTask(userId, task.id, { lastError: error });
      const fresh = (await this.repo.getTask(userId, task.id)) ?? task;
      await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.FAIL, {
        actor: 'worker',
        detail: { jobId: job.id, reason: 'merge' },
        idempotencyKey: `job:${job.id}:merge-transition`,
      });
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
  }

  async reconcilePullRequest(url: string, status: 'open' | 'merged' | 'closed', mergedAt: string | null): Promise<boolean> {
    const pullRequest = await this.repo.findPullRequestByUrl(url);
    if (!pullRequest) return false;
    if (pullRequest.status === status && pullRequest.mergedAt === mergedAt) return true;
    await this.repo.upsertPullRequest(pullRequest.userId, pullRequest.taskId, {
      taskRepositoryId: pullRequest.taskRepositoryId,
      repository: pullRequest.repository,
      url: pullRequest.url,
      number: pullRequest.number,
      branch: pullRequest.branch,
      baseBranch: pullRequest.baseBranch,
      headSha: pullRequest.headSha,
      status,
      mergedAt,
    });
    await this.repo.createEvent(pullRequest.userId, {
      taskId: pullRequest.taskId,
      type: 'pull-request-reconciled',
      detail: { pullRequestId: pullRequest.id, repository: pullRequest.repository, url, status, mergedAt },
    });
    const task = await this.repo.getTask(pullRequest.userId, pullRequest.taskId);
    if (task?.state === 'merge' && status === 'merged') {
      const all = await this.repo.listPullRequests(pullRequest.userId, pullRequest.taskId);
      if (all.length > 0 && all.every((item) => item.status === 'merged')) {
        await this.repo.cancelQueuedJobs(pullRequest.userId, pullRequest.taskId);
        await this.applyEvent(pullRequest.userId, task, 'complete', { actor: 'system', detail: { reason: 'github-webhook' } });
      }
    }
    this.hub.publish(pullRequest.userId, { type: 'task.updated', taskId: pullRequest.taskId });
    return true;
  }

  // ---------------------------------------------------------------- sweeper

  /** Requeue (or fail) jobs whose worker disappeared. Runs periodically from the app. */
  async sweepStaleJobs(now: Date = this.now()): Promise<{ requeued: number; failed: number }> {
    const cutoff = now.getTime() - STALE_JOB_AFTER_MS;
    const lostCutoff = now.getTime() - WORKER_LOST_AFTER_MS;
    let requeued = 0;
    let failed = 0;
    for (const job of await this.repo.listActiveJobs()) {
      if (job.status === 'applying') {
        const outcomeStartedAt = job.outcomeStartedAt ? Date.parse(job.outcomeStartedAt) : 0;
        if (outcomeStartedAt > now.getTime() - OUTCOME_LEASE_MS) continue;
        if (!job.outcomeHash || !job.outcomeToken || (!job.result && !job.error)) {
          this.log.error({ jobId: job.id }, 'cannot recover job with incomplete outcome state');
          continue;
        }
        await this.repo.abandonJobOutcome(job.userId, job.id, job.attempt, job.outcomeHash, job.outcomeToken);
        if (job.result) await this.completeJob(job.userId, job.id, job.result, job.attempt);
        else await this.failJob(job.userId, job.id, job.error!, job.attempt);
        this.log.warn({ jobId: job.id, attempt: job.attempt }, 'resumed abandoned job outcome');
        continue;
      }
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
  return messagesSinceLastAgentMessage(messages)
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');
}

function messagesSinceLastAgentMessage(messages: Message[]): Message[] {
  let lastAgent = -1;
  messages.forEach((m, i) => {
    if (m.role === 'agent') lastAgent = i;
  });
  return messages.slice(lastAgent + 1);
}

function lastAgentSummary(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'agent') return m.content;
  }
  return '';
}
