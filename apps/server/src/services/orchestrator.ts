import { createHash } from 'node:crypto';
import {
  DEFAULT_TROUBLESHOOT_STEP,
  TERMINAL_STATES,
  TransitionError,
  UNIVERSAL_EVENTS,
  chatTriggersFeedback,
  eventForResult,
  extractTaskContract,
  extractMarkdownSection,
  getStep,
  isAgentActive,
  removeMarkdownSection,
  snapshotWorkflow,
  transition,
  type AgentResult,
  type AgentEngine,
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
import type { Metrics } from '../metrics.js';
import { parsePrUrl } from './github.js';
import type { NotificationSink, TaskNotification } from './notifications.js';
import { toWorkflow, type WorkflowService } from './workflows.js';
import { verifyDesignFiles } from './designs.js';

export type Actor = 'user' | 'worker' | 'system';

interface ApplyOptions {
  actor: Actor;
  idempotencyKey?: string;
  expectedVersion?: number;
  /** Replaces the chat-derived feedback in the dispatched job context (used for verify NO_GO). */
  feedbackOverride?: string;
  detail?: Record<string, unknown>;
  /** GitHub already confirmed every PR merged, so no merge side effect is needed. */
  confirmedExternalMerge?: boolean;
}

export interface OrchestratorDeps {
  repo: Repository;
  hub: Hub;
  workflows: WorkflowService;
  log: FastifyBaseLogger;
  metrics?: Metrics;
  notifications?: NotificationSink;
  autoMergeEnabled?: boolean;
  now?: () => Date;
}

export const REVIEW_ARTIFACT = 'adversarial-review.md';
export const DIFF_EXPLANATION_ARTIFACT = 'diff-explanation.md';
export const REVIEW_SLICES_ARTIFACT = 'review-slices.json';
export const VERIFY_ARTIFACT = 'verify-report.md';
export const CONFLICT_PROMPT_VERSION = 'rebase-conflict-v1';
export const OUTCOME_LEASE_MS = 30_000;
export const MAX_JOB_ATTEMPTS = 3;
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

const TASK_CONTRACT_PROMPT = `## Task contract (mandatory)

Required outcome:
{{task_outcome}}

Acceptance criteria:
{{acceptance_criteria}}

Treat this contract as the definition of done. Your work and evidence must account for the outcome and every acceptance criterion.

If either field is empty, define it from the task source before doing the work, use the generated contract to guide the work, and return both fields in your structured result so the contract becomes durable.`;

const PLANNING_CONTRACT_PROMPT = `${TASK_CONTRACT_PROMPT}

When revising a plan, update the contract when the user's feedback requests a change. Return both fields in the structured plan result.`;

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
 * Drives tasks through their workflow: transitions, job dispatch, worker results
 * and failure handling. All state lives in the repository; this class is
 * stateless and safe to construct per app.
 */
export class Orchestrator {
  private readonly repo: Repository;
  private readonly hub: Hub;
  private readonly workflows: WorkflowService;
  private readonly log: FastifyBaseLogger;
  private readonly metrics: Metrics | undefined;
  private readonly notifications: NotificationSink | undefined;
  private readonly now: () => Date;
  private readonly autoMergeEnabled: boolean;

  constructor(deps: OrchestratorDeps) {
    this.repo = deps.repo;
    this.hub = deps.hub;
    this.workflows = deps.workflows;
    this.log = deps.log;
    this.metrics = deps.metrics;
    this.notifications = deps.notifications;
    this.autoMergeEnabled = deps.autoMergeEnabled ?? true;
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
    const project = input.projectId ? await this.repo.getProject(userId, input.projectId) : null;
    if (input.projectId && !project) throw badRequest('Unknown project');
    const projectRepos = project?.repositories.map((repo) => repo.repository) ?? [];
    const repos = project ? (input.repos.length > 0 ? input.repos : projectRepos) : input.repos;
    if (project) {
      const allowed = new Set(projectRepos);
      const outsideProject = repos.find((repo) => !allowed.has(repo));
      if (outsideProject) throw badRequest(`Repository ${outsideProject} is not part of the selected project`);
    }
    const importedContract = extractTaskContract(input.description);
    if (input.designHandoff) {
      const selectedWorkflow = workflowId ? await this.workflows.get(userId, workflowId) : null;
      if (!repos.length || !selectedWorkflow?.steps.some((step) => ['implementation', 'pr', 'review-slice'].includes(step.output ?? ''))) {
        throw badRequest('A design implementation task requires repositories and an implementation workflow');
      }
    }
    const taskInput = {
      key,
      title: input.title,
      description: input.description,
      projectId: project?.id ?? null,
      outcome: importedContract.outcome ?? '',
      acceptanceCriteria: importedContract.acceptanceCriteria ?? '',
      state: 'todo',
      currentStepId: null,
      workflowId,
      pinnedWorkflow: null,
      repos,
      ticketUrl: input.ticketUrl ?? null,
      branch: repos.length > 0 ? branchNameFor(key) : null,
      baseBranch: null,
      parentTaskId: null,
      sequence: null,
    } satisfies Parameters<Repository['createTask']>[1];
    const task = input.designHandoff
      ? await this.repo.createTaskWithDesign(userId, taskInput, input.designHandoff.revisionId, input.designHandoff.idempotencyKey,
        createHash('sha256').update(JSON.stringify(input)).digest('hex'))
      : await this.repo.createTask(userId, taskInput);
    await this.syncTaskRepositories(userId, task);
    await this.repo.createEvent(userId, { taskId: task.id, type: 'created', toState: task.state, detail: { actor: 'user' }, dedupeKey: input.designHandoff ? 'design-handoff-created' : undefined });
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
    const [messages, events, artifacts, subtasks, repositories, pullRequests, designHandoff] = await Promise.all([
      this.repo.listMessages(userId, id),
      this.repo.listEvents(userId, id),
      this.repo.listArtifacts(userId, id),
      this.repo.listSubtasks(userId, id),
      this.repo.listTaskRepositories(userId, id),
      this.repo.listPullRequests(userId, id),
      this.repo.getDesignHandoff(userId, id),
    ]);
    return { ...task, messages, events, artifacts, subtasks, repositories, pullRequests,
      designInput: designHandoff ? { sourceTaskId: designHandoff.sourceTaskId, revisionId: designHandoff.revisionId, approvedAt: designHandoff.approvedAt } : null };
  }

  async updateTask(userId: string, id: string, patch: UpdateTaskInput): Promise<Task> {
    const task = await this.getTask(userId, id);
    const changes: Parameters<Repository['updateTask']>[2] = {};
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.repos !== undefined || patch.workflowId !== undefined || patch.projectId !== undefined) {
      if (task.state !== 'todo') throw conflict('Repositories and workflow can only be changed while the task is in todo');
      let projectRepos: string[] | null = null;
      if (patch.projectId !== undefined) {
        if (patch.projectId === null) {
          changes.projectId = null;
        } else {
          const project = await this.repo.getProject(userId, patch.projectId);
          if (!project) throw badRequest('Unknown project');
          changes.projectId = project.id;
          projectRepos = project.repositories.map((repo) => repo.repository);
        }
      } else if (task.projectId) {
        const project = await this.repo.getProject(userId, task.projectId);
        projectRepos = project?.repositories.map((repo) => repo.repository) ?? null;
      }
      if (patch.repos !== undefined) {
        if (projectRepos) {
          const allowed = new Set(projectRepos);
          const outsideProject = patch.repos.find((repo) => !allowed.has(repo));
          if (outsideProject) throw badRequest(`Repository ${outsideProject} is not part of the selected project`);
        }
        changes.repos = patch.repos;
        changes.branch = patch.repos.length > 0 ? (task.branch ?? branchNameFor(task.key)) : null;
      } else if (projectRepos && patch.projectId !== undefined) {
        changes.repos = projectRepos;
        changes.branch = projectRepos.length > 0 ? (task.branch ?? branchNameFor(task.key)) : null;
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

  async stopRunningAgentStep(userId: string, id: string): Promise<Task> {
    const task = await this.getTask(userId, id);
    const workflow = await this.resolveWorkflow(userId, task);
    const step = workflow ? getStep(workflow, task.currentStepId) : null;
    if (!workflow || !isAgentActive(task, workflow) || step?.type !== 'agent' || step.output === 'merge') {
      throw conflict('There is no running agent step to stop');
    }
    const cancelled = await this.repo.requestAgentJobCancellation(userId, id);
    if (cancelled === 0) throw conflict('There is no running agent job to stop');
    const stopped = (await this.repo.updateTask(userId, id, { lastError: `${step.label} was stopped by the user.` })) ?? task;
    const current = await this.applyEvent(userId, stopped, UNIVERSAL_EVENTS.FAIL, {
      actor: 'user',
      detail: { reason: 'stopped-by-user', cancelledJobs: cancelled },
      idempotencyKey: `stop-agent:${task.id}:${task.version}`,
    });
    await this.repo.createMessage(userId, {
      taskId: task.id,
      role: 'system',
      content: `${step.label} was stopped. Add guidance in chat, then retry the step when you're ready.`,
      source: 'web',
      externalId: `stop-agent:${task.id}:${task.version}:message`,
    });
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    return current;
  }

  /** The workflow governing a task: the pinned snapshot once started, otherwise the live workflow. */
  async resolveWorkflow(userId: string, task: Task): Promise<Workflow | null> {
    if (task.pinnedWorkflow) return task.pinnedWorkflow;
    if (!task.workflowId) return null;
    const live = await this.workflows.get(userId, task.workflowId);
    return live ? toWorkflow(live) : null;
  }

  async repinWorkflow(userId: string, taskId: string, expectedVersion: number, idempotencyKey: string): Promise<Task> {
    const task = await this.getTask(userId, taskId);
    if (TERMINAL_STATES.has(task.state)) throw conflict('Closed tasks cannot be moved to a newer workflow version');
    if (!task.pinnedWorkflow) throw conflict('This task is not pinned yet');
    if (!task.workflowId) throw conflict('This task no longer has a live workflow to pin');
    const activeJob = (await this.repo.listJobsForTask(userId, task.id)).find((job) => ['queued', 'claimed', 'running', 'applying'].includes(job.status));
    if (activeJob) throw conflict('Task has active work; wait for it to finish before updating its pinned workflow');
    const live = await this.workflows.get(userId, task.workflowId);
    if (!live) throw conflict('The live workflow for this task no longer exists');
    const pinnedWorkflow = snapshotWorkflow(toWorkflow(live));
    const detail = { actor: 'user', workflowId: live.id, workflowName: live.name };
    const requestHash = transitionRequestHash(userId, task.id, expectedVersion, 'workflow-repinned', 'user', detail);
    const replay = await this.repo.getTaskTransitionReplay(userId, idempotencyKey, requestHash);
    if (replay) return replay.task;
    if (JSON.stringify(pinnedWorkflow) === JSON.stringify(task.pinnedWorkflow)) {
      if (task.version !== expectedVersion) throw conflict(`Task version ${expectedVersion} is stale; current version is ${task.version}`);
      return task;
    }

    const applied = await this.repo.applyTaskTransition(userId, {
      taskId: task.id,
      expectedVersion,
      idempotencyKey,
      requestHash,
      patch: {
        state: task.state,
        currentStepId: task.currentStepId,
        failedStepId: task.failedStepId,
        pinnedWorkflow,
      },
      event: {
        taskId: task.id,
        type: 'workflow-repinned',
        fromState: task.state,
        toState: task.state,
        stepId: task.currentStepId,
        detail,
      },
    });
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    return applied.task;
  }

  // ---------------------------------------------------------------- events & messages

  async applyUserEvent(userId: string, taskId: string, event: string, expectedVersion?: number, idempotencyKey?: string): Promise<Task> {
    const task = await this.getTask(userId, taskId);
    if (event === UNIVERSAL_EVENTS.RESTACKED) throw badRequest('The restacked event is reserved for stack maintenance');
    const version = expectedVersion ?? task.version;
    const key = idempotencyKey ?? `direct:${task.id}:${version}:${event}`;
    const replay = await this.repo.getTaskTransitionReplay(userId, key, transitionRequestHash(userId, task.id, version, event, 'user', undefined));
    if (replay) {
      return replay.task;
    }
    if (task.version !== version) throw conflict(`Task version ${version} is stale; current version is ${task.version}`);
    if (event === 'accept' && task.state === 'design-review') {
      const revisions = await this.repo.listDesignRevisions(userId, task.id);
      if (!revisions.at(-1)?.approvedAt) throw conflict('Approve the current design revision in the Design tab before finishing');
    }
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
    const workflow = await this.resolveWorkflow(userId, task);
    const triggersFeedback = workflow !== null && chatTriggersFeedback(task, workflow);
    const message = await this.repo.createMessage(userId, {
      taskId,
      role: 'user',
      content,
      source,
      externalId: externalId ?? null,
      githubFeedback: githubFeedback ?? null,
    });
    if (triggersFeedback) {
      task = await this.applyEvent(userId, task, 'feedback', {
        actor: 'user',
        detail: { source },
        ...(externalId ? { idempotencyKey: `message:${source}:${task.id}:${externalId}:feedback` } : {}),
      });
      if (source === 'web') {
        const activeStep = getStep(workflow, task.currentStepId);
        try {
          await this.repo.createMessage(userId, {
            taskId,
            role: 'system',
            content: `Got it — ${activeStep?.label ?? 'the worker'} is working on your request.`,
            source,
          });
          this.hub.publish(userId, { type: 'task.updated', taskId });
        } catch (error) {
          this.log.warn({ err: error, userId, taskId }, 'worker acknowledgement could not be saved after feedback dispatch');
        }
      }
    } else if (message && workflow !== null && isAgentActive(task, workflow)) {
      if (getStep(workflow, task.currentStepId)?.output === 'design') {
        const fresh = await this.getTask(userId, taskId);
        if (chatTriggersFeedback(fresh, workflow)) {
          try { task = await this.applyEvent(userId, fresh, 'feedback', { actor: 'user', feedbackOverride: content }); }
          catch (error) { task = await this.getTask(userId, taskId); if (chatTriggersFeedback(task, workflow)) throw error; }
        }
        await this.repo.createMessage(userId, { taskId, role: 'system', source, content: 'Your feedback is queued for the next design turn.' });
        this.hub.publish(userId, { type: 'task.updated', taskId });
      } else task = await this.restartRunningAgentStep(userId, task, workflow, source);
    } else if (message) {
      this.hub.publish(userId, { type: 'task.updated', taskId });
    }
    return { message, task };
  }

  private async restartRunningAgentStep(userId: string, task: Task, workflow: Workflow, source: MessageSource): Promise<Task> {
    const step = getStep(workflow, task.currentStepId);
    if (!step || step.type !== 'agent' || step.output === 'merge') {
      this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
      return task;
    }
    const hadRunningAgent = (await this.repo.listJobsForTask(userId, task.id)).some((job) => job.kind === 'agent' && (job.status === 'claimed' || job.status === 'running'));
    const cancelled = await this.repo.requestAgentJobCancellation(userId, task.id);
    const job = await this.buildAgentJob(userId, task, step);
    const expectedVersion = task.version;
    const detail = { actor: 'user', event: 'restart-agent', source, cancelledJobs: cancelled };
    const applied = await this.repo.applyTaskTransition(userId, {
      taskId: task.id,
      expectedVersion,
      idempotencyKey: `restart-agent:${task.id}:${expectedVersion}:${Date.now()}`,
      requestHash: transitionRequestHash(userId, task.id, expectedVersion, 'restart-agent', 'user', detail),
      patch: {
        state: task.state,
        currentStepId: task.currentStepId,
        failedStepId: task.failedStepId,
      },
      event: {
        taskId: task.id,
        type: 'agent-restarted',
        fromState: task.state,
        toState: task.state,
        stepId: step.id,
        detail,
      },
      job,
      cancelQueuedJobs: true,
    });
    if (hadRunningAgent) {
      await this.repo.createMessage(userId, {
        taskId: task.id,
        role: 'system',
        content: `Got it — restarting ${step.label} with your feedback.`,
        source,
      });
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    return applied.task;
  }

  private async applyEvent(userId: string, task: Task, event: string, options: ApplyOptions): Promise<Task> {
    if (options.idempotencyKey) {
      const replay = await this.repo.getTaskTransitionReplayByKey(userId, options.idempotencyKey);
      if (replay) {
        return replay.task;
      }
    }
    const live = await this.resolveWorkflow(userId, task);
    const pinNow = task.pinnedWorkflow === null && live !== null;
    const workflow = pinNow && live ? snapshotWorkflow(live) : live;

    if (task.plan && (!task.outcome.trim() || !task.acceptanceCriteria.trim())) {
      const recovered = extractTaskContract(task.plan);
      const outcome = task.outcome.trim() || recovered.outcome || '';
      const acceptanceCriteria = task.acceptanceCriteria.trim() || recovered.acceptanceCriteria || '';
      if (outcome !== task.outcome || acceptanceCriteria !== task.acceptanceCriteria) {
        task = (await this.repo.updateTask(userId, task.id, { outcome, acceptanceCriteria })) ?? task;
      }
    }

    const t: Transition = transition(task, workflow, event);
    const manuallyClosing = event === UNIVERSAL_EVENTS.MARK_DONE || event === UNIVERSAL_EVENTS.MARK_WONT_DO;
    if (!manuallyClosing && task.plan && (!task.outcome.trim() || !task.acceptanceCriteria.trim())) {
      const dispatchesNonPlanningAgent = t.effects.some((effect) => {
        if (effect.type !== 'dispatch') return false;
        return workflow ? getStep(workflow, effect.stepId)?.output !== 'plan' : false;
      });
      if (dispatchesNonPlanningAgent || t.effects.some((effect) => effect.type === 'complete-task')) {
        throw conflict('The plan needs an outcome and acceptance criteria before this task can advance. Send feedback to the planning agent to add them.');
      }
    }
    const patch: Parameters<Repository['applyTaskTransition']>[1]['patch'] = {
      state: t.nextState,
      currentStepId: t.nextStepId,
      failedStepId: t.failedStepId,
    };
    if (pinNow) patch.pinnedWorkflow = workflow;
    let queuedJob: Parameters<Repository['createJob']>[1] | undefined;
    for (const effect of t.effects) {
      if (effect.type === 'dispatch') {
        if (!workflow) throw new TransitionError('Task has no workflow', 'NO_WORKFLOW');
        const step = getStep(workflow, effect.stepId);
        if (!step) throw new TransitionError(`Unknown step ${effect.stepId}`, 'NO_STEP');
        if (step.output === 'merge') {
          if (!options.confirmedExternalMerge) queuedJob = await this.buildMergeJob(userId, task, step.id);
        } else queuedJob = await this.buildAgentJob(userId, task, step, options.feedbackOverride);
      } else if (effect.type === 'dispatch-troubleshoot') {
        if (!workflow) throw new TransitionError('Task has no workflow', 'NO_WORKFLOW');
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
      cancelQueuedJobs: event === UNIVERSAL_EVENTS.FAIL || event === UNIVERSAL_EVENTS.MARK_DONE || event === UNIVERSAL_EVENTS.MARK_WONT_DO,
    });
    if (applied.replayed) {
      return applied.task;
    }

    const current = applied.task;
    await this.notifyIfNeedsAttention(userId, task, current, workflow, options);

    this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
    return (await this.repo.getTask(userId, task.id)) ?? current;
  }

  private async notifyIfNeedsAttention(
    userId: string,
    previous: Task,
    current: Task,
    workflow: Workflow | null,
    options: ApplyOptions,
  ): Promise<void> {
    if (!this.notifications || options.actor === 'user') return;
    let notification: TaskNotification | null = null;
    if (current.state === 'failure') {
      const failedStep = workflow ? getStep(workflow, current.failedStepId ?? current.currentStepId) : null;
      notification = { kind: 'failure', task: current, stepLabel: failedStep?.label ?? null, error: current.lastError };
    } else {
      const previousStep = workflow ? getStep(workflow, previous.currentStepId) : null;
      const currentStep = workflow ? getStep(workflow, current.currentStepId) : null;
      if (previousStep?.type === 'agent' && currentStep?.type === 'human') {
        notification = { kind: 'needs-input', task: current, stepLabel: currentStep.label, error: null };
      }
    }
    if (!notification) return;
    try {
      await this.notifications.notifyTaskStatus(userId, notification);
    } catch (error) {
      this.log.warn({ err: error, userId, taskId: current.id, kind: notification.kind }, 'task notification failed');
    }
  }

  // ---------------------------------------------------------------- dispatch

  private async buildAgentJob(
    userId: string,
    task: Task,
    step: WorkflowStep,
    feedbackOverride?: string,
  ): Promise<Parameters<Repository['createJob']>[1]> {
    const context = await this.buildJobContext(userId, task, feedbackOverride);
    const contractPrompt = step.output === 'plan' ? PLANNING_CONTRACT_PROMPT : TASK_CONTRACT_PROMPT;
    const stepWithContract = { ...step, prompt: `${step.prompt ?? ''}\n\n${contractPrompt}`.trim() };
    const resumeSessionId = await this.findResumeSessionId(userId, task.id, step);
    const designHandoff = await this.repo.getDesignHandoff(userId, task.id);
    const designMessages = step.output === 'design' ? await this.repo.listMessages(userId, task.id) : [];
    if (step.output === 'design') {
      const revisions = await this.repo.listDesignRevisions(userId, task.id);
      const latest = revisions.at(-1);
      stepWithContract.prompt += `\n\n## Durable design context\n${latest ? `Continue the saved design files from revision ${latest.id}.\n${latest.result.specification}` : 'No completed revision yet. Inspect the restored session and workspace before creating preview files.'}\n\nConversation:\n${designMessages.map((message) => `${message.role}: ${message.content}`).join('\n\n').slice(-60_000)}`;
    }
    return {
      taskId: task.id,
      kind: 'agent',
      stepId: step.id,
      payload: { kind: 'agent', step: stepWithContract, context, repos: task.repos, branch: task.branch, baseBranch: task.baseBranch, prUrl: task.prUrl, resumeSessionId,
        ...(designHandoff ? { designHandoff: { sourceTaskId: designHandoff.sourceTaskId, revisionId: designHandoff.revisionId, approvedAt: designHandoff.approvedAt } } : {}), ...(step.output === 'design' ? { designMessageIds: designMessages.filter((message) => message.role === 'user').map((message) => message.id) } : {}) },
    };
  }

  private async findResumeSessionId(userId: string, taskId: string, step: WorkflowStep): Promise<string | null> {
    const sessionKey = step.resumeSessionKey?.trim();
    if (!sessionKey) return null;
    const engine = step.engine ?? 'claude';
    const events = await this.repo.listEvents(userId, taskId);
    for (const event of [...events].reverse()) {
      if (event.type !== 'agent-session' || !event.detail || typeof event.detail !== 'object') continue;
      const detail = event.detail as Record<string, unknown>;
      if (detail['engine'] !== engine) continue;
      if (detail['sessionKey'] !== sessionKey) continue;
      const sessionId = detail['sessionId'];
      if (typeof sessionId === 'string' && sessionId.trim()) return sessionId;
    }
    return null;
  }

  private async buildMergeJob(userId: string, task: Task, stepId: string): Promise<Parameters<Repository['createJob']>[1]> {
    if (!this.autoMergeEnabled) throw serviceUnavailable('Automatic merge is disabled by the server operator');
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

    return {
      task_key: task.key,
      task_title: task.title,
      task_description: task.description,
      task_outcome: task.outcome,
      acceptance_criteria: task.acceptanceCriteria,
      plan: task.plan ?? '',
      feedback,
      pr_url: task.prUrl ?? '',
      parent_plan: '',
      sibling_summaries: '',
      review_slices: latest(REVIEW_SLICES_ARTIFACT),
      review: latest(REVIEW_ARTIFACT),
      verify_report: latest(VERIFY_ARTIFACT),
      error: task.lastError ?? '',
      ...(githubFeedback ? { github_feedback: githubFeedback } : {}),
    };
  }

  // ---------------------------------------------------------------- worker results

  async completeJob(userId: string, jobId: string, result: AgentResult, expectedAttempt: number, leaseToken: string, agentSessionId?: string | null): Promise<void> {
    const job = await this.repo.getJob(userId, jobId);
    if (!job) throw notFound('Job');
    if (job.attempt !== expectedAttempt) throw conflict(`Job attempt ${expectedAttempt} has been superseded`);
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
    if (result.kind === 'design') verifyDesignFiles(result.files);

    const task = await this.repo.getTask(userId, job.taskId);
    if (!task) throw notFound('Task');
    // Reject contract-incomplete agent output before acquiring the durable
    // outcome claim. Once a hash is accepted it must stay pinned so partially
    // applied effects can only be replayed with the exact same outcome.
    if (result.kind !== 'rebase' && result.kind !== 'conflict-resolution' && result.kind !== 'merge') {
      this.taskContractFromResult(task, result);
    }
    const attempt = expectedAttempt;
    const outcomeHash = this.jobOutcomeHash({ result });
    const claim = await this.beginJobOutcome(userId, job.id, attempt, outcomeHash, { result }, leaseToken);
    if (claim.state === 'replay') {
      return;
    }
    if (claim.state === 'busy' || !claim.token) throw serviceUnavailable('Job outcome is already being applied; retry shortly');
    try {
      const currentTask = await this.repo.getTask(userId, task.id);
      if (currentTask && TERMINAL_STATES.has(currentTask.state)) {
        this.log.warn({ userId, jobId: job.id, taskId: task.id }, 'job result arrived after task closure; discarded');
        await this.repo.createEvent(userId, {
          taskId: task.id,
          type: 'stale-result',
          stepId: job.stepId,
          detail: { jobId: job.id, reason: 'task-closed' },
          dedupeKey: `job:${job.id}:stale-result`,
        });
        await this.repo.finalizeJobOutcome(userId, job.id, attempt, outcomeHash, claim.token, 'completed');
        return;
      }
      if (result.kind === 'rebase') await this.applyRebaseResult(userId, claim.job, task, result);
      else if (result.kind === 'conflict-resolution') await this.applyConflictResolutionResult(userId, claim.job, task, result);
      else if (result.kind === 'merge') await this.applyMergeResult(userId, claim.job, task, result);
      else {
        let current = await this.applyResult(userId, claim.job, task, result);
        await this.recordAgentSession(userId, claim.job, agentSessionId ?? null);
        await this.repo.createMessage(userId, {
          taskId: task.id,
          role: 'agent',
          content: result.kind === 'design' && result.questions.length ? `${result.summary}\n\n${result.questions.map((question) => `- ${question}`).join('\n')}` : result.summary,
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
          this.log.warn({ userId, jobId: job.id, taskId: task.id }, 'job result arrived for a task that has moved on; stored without transition');
          await this.repo.createEvent(userId, {
            taskId: task.id,
            type: 'stale-result',
            stepId: job.stepId,
            detail: { jobId: job.id },
            dedupeKey: `job:${job.id}:stale-result`,
          });
        }
        if (result.kind === 'design' && claim.job.payload.kind === 'agent') {
          const included = new Set(claim.job.payload.designMessageIds ?? []);
          const pending = (await this.repo.listMessages(userId, task.id)).filter((message) => message.role === 'user' && !included.has(message.id));
          const fresh = await this.getTask(userId, task.id);
          if (pending.length && fresh.state === 'design-review') {
            current = await this.applyEvent(userId, fresh, 'feedback', { actor: 'system', feedbackOverride: pending.map((message) => message.content).join('\n\n'), idempotencyKey: `job:${job.id}:queued-design-feedback` });
          }
        }
        this.hub.publish(userId, { type: 'task.updated', taskId: task.id });
      }
      await this.repo.finalizeJobOutcome(userId, job.id, attempt, outcomeHash, claim.token, 'completed');
      this.recordResultMetrics(result);
      if (job.claimedAt) this.metrics?.observe('sindral_job_duration_seconds', Math.max(0, (this.now().getTime() - Date.parse(job.claimedAt)) / 1000), { kind: job.kind, outcome: 'completed' });
    } catch (error) {
      await this.repo.abandonJobOutcome(userId, job.id, attempt, outcomeHash, claim.token);
      throw error;
    }
  }

  async failJob(userId: string, jobId: string, error: string, expectedAttempt: number, leaseToken: string): Promise<void> {
    const job = await this.repo.getJob(userId, jobId);
    if (!job) throw notFound('Job');
    if (job.attempt !== expectedAttempt) throw conflict(`Job attempt ${expectedAttempt} has been superseded`);
    const task = await this.repo.getTask(userId, job.taskId);
    if (!task) throw notFound('Task');
    const attempt = expectedAttempt;
    const outcomeHash = this.jobOutcomeHash({ error });
    const claim = await this.beginJobOutcome(userId, job.id, attempt, outcomeHash, { error }, leaseToken);
    if (claim.state === 'replay') {
      return;
    }
    if (claim.state === 'busy' || !claim.token) throw serviceUnavailable('Job outcome is already being applied; retry shortly');
    try {
      const currentTask = await this.repo.getTask(userId, task.id);
      if (currentTask && TERMINAL_STATES.has(currentTask.state)) {
        this.log.warn({ userId, jobId: job.id, taskId: task.id }, 'job failure arrived after task closure; discarded');
        await this.repo.createEvent(userId, {
          taskId: task.id,
          type: 'stale-result',
          stepId: job.stepId,
          detail: { jobId: job.id, reason: 'task-closed' },
          dedupeKey: `job:${job.id}:stale-result`,
        });
        await this.repo.finalizeJobOutcome(userId, job.id, attempt, outcomeHash, claim.token, 'failed');
        return;
      }
      await this.failTask(userId, task, claim.job, error, attempt);
      await this.repo.finalizeJobOutcome(userId, job.id, attempt, outcomeHash, claim.token, 'failed');
      if (job.kind === 'merge-pull-requests') this.metrics?.inc('sindral_merge_failures_total');
      if (job.kind === 'resolve-rebase-conflict') this.metrics?.inc('sindral_conflict_resolution_total', { outcome: 'escalated' });
      if (job.claimedAt) this.metrics?.observe('sindral_job_duration_seconds', Math.max(0, (this.now().getTime() - Date.parse(job.claimedAt)) / 1000), { kind: job.kind, outcome: 'failed' });
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

  private recordResultMetrics(result: AgentResult): void {
    if (result.kind === 'rebase' && result.rebased.some((entry) => entry.conflict)) this.metrics?.inc('sindral_rebase_conflicts_total');
    if (result.kind === 'conflict-resolution') {
      this.metrics?.inc('sindral_conflict_resolution_total', { outcome: result.resolved ? 'resolved' : 'escalated' });
      if (result.checks.some((check) => !check.ok)) this.metrics?.inc('sindral_validation_failures_total', { surface: 'conflict-resolution' });
    }
    if (result.kind === 'merge' && !result.complete) this.metrics?.inc('sindral_merge_failures_total');
    if (result.kind === 'verdict' && result.verdict === 'NO_GO') this.metrics?.inc('sindral_validation_failures_total', { surface: 'verification' });
  }

  private async recordAgentSession(userId: string, job: Job, sessionId: string | null): Promise<void> {
    if (!sessionId || job.payload.kind !== 'agent') return;
    const step = job.payload.step;
    const sessionKey = step.resumeSessionKey?.trim();
    if (!sessionKey) return;
    const engine: AgentEngine = step.engine ?? 'claude';
    await this.repo.createEvent(userId, {
      taskId: job.taskId,
      type: 'agent-session',
      stepId: step.id,
      detail: { jobId: job.id, stepId: step.id, sessionKey, engine, sessionId },
      dedupeKey: `job:${job.id}:agent-session`,
    });
  }

  private async beginJobOutcome(
    userId: string,
    jobId: string,
    attempt: number,
    outcomeHash: string,
    outcome: { result: AgentResult; error?: never } | { error: string; result?: never },
    leaseToken: string,
  ): Promise<JobOutcomeClaim> {
    try {
      return await this.repo.beginJobOutcome(userId, jobId, attempt, outcomeHash, outcome, leaseToken);
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
    const generatedContract = this.taskContractFromResult(task, result);
    const persistGeneratedContract = async (): Promise<Task> => {
      if (!generatedContract) return task;
      task = (await this.repo.updateTask(userId, task.id, generatedContract)) ?? task;
      return task;
    };
    switch (result.kind) {
      case 'plan': {
        const { outcome, acceptanceCriteria } = generatedContract!;
        const updated = await this.repo.updateTask(userId, task.id, { plan: result.plan, outcome, acceptanceCriteria });
        return updated ?? task;
      }
      case 'implementation':
        return persistGeneratedContract();
      case 'pr': {
        return this.applyPullRequestResult(userId, task, result, generatedContract ?? undefined);
      }
      case 'review-slice': {
        await this.repo.createArtifact(userId, {
          taskId: task.id,
          jobId: job.id,
          name: REVIEW_SLICES_ARTIFACT,
          contentType: 'application/json',
          content: JSON.stringify({ summary: result.summary, slices: result.slices }, null, 2),
          dedupeKey: `job:${job.id}:artifact:${REVIEW_SLICES_ARTIFACT}`,
        });
        return this.applyPullRequestResult(userId, task, result, generatedContract ?? undefined);
      }
      case 'review':
        {
          const diffExplanation = extractMarkdownSection(result.report, 'Diff explanation');
          if (diffExplanation) {
            await this.repo.createArtifact(userId, {
              taskId: task.id,
              jobId: job.id,
              name: DIFF_EXPLANATION_ARTIFACT,
              contentType: 'text/markdown',
              content: diffExplanation,
              dedupeKey: `job:${job.id}:artifact:${DIFF_EXPLANATION_ARTIFACT}`,
            });
          }
          const reviewReport = diffExplanation ? removeMarkdownSection(result.report, 'Diff explanation') : result.report;
          await this.repo.createArtifact(userId, {
            taskId: task.id,
            jobId: job.id,
            name: REVIEW_ARTIFACT,
            contentType: 'text/markdown',
            content: reviewReport,
            dedupeKey: `job:${job.id}:artifact:${REVIEW_ARTIFACT}`,
          });
        }
        return persistGeneratedContract();
      case 'verdict':
        await this.repo.createArtifact(userId, {
          taskId: task.id,
          jobId: job.id,
          name: VERIFY_ARTIFACT,
          contentType: 'text/markdown',
          content: result.report,
          dedupeKey: `job:${job.id}:artifact:${VERIFY_ARTIFACT}`,
        });
        return persistGeneratedContract();
      case 'design':
        if (result.screens.length && this.isJobCurrent(task, job)) await this.repo.createDesignRevision(userId, task.id, job.id, result);
        return persistGeneratedContract();
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
        return persistGeneratedContract();
      case 'troubleshoot':
        await this.repo.createMessage(userId, {
          taskId: task.id,
          role: 'agent',
          content: result.diagnosis,
          source: 'worker',
          externalId: `job:${job.id}:diagnosis`,
        });
        return persistGeneratedContract();
    }
  }

  private async applyPullRequestResult(
    userId: string,
    task: Task,
    result: Extract<AgentResult, { kind: 'pr' | 'review-slice' }>,
    generatedContract?: Pick<Task, 'outcome' | 'acceptanceCriteria'>,
  ): Promise<Task> {
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
    return (
      (await this.repo.updateTask(userId, task.id, {
        prUrl: result.prUrl,
        branch: result.branch || task.branch,
        ...(generatedContract ?? {}),
      })) ?? task
    );
  }

  /** Resolve and validate task-contract fields without mutating durable outcome state. */
  private taskContractFromResult(
    task: Task,
    result: Exclude<AgentResult, { kind: 'rebase' | 'conflict-resolution' | 'merge' }>,
  ): Pick<Task, 'outcome' | 'acceptanceCriteria'> | null {
    if (result.kind === 'plan') {
      const embedded = extractTaskContract(result.plan);
      const outcome = result.outcome?.trim() || embedded.outcome || task.outcome.trim();
      const acceptanceCriteria = result.acceptanceCriteria?.trim() || embedded.acceptanceCriteria || task.acceptanceCriteria.trim();
      if (!outcome || !acceptanceCriteria) throw badRequest('Plan results must define a task outcome and acceptance criteria');
      return { outcome, acceptanceCriteria };
    }
    if (task.outcome.trim() && task.acceptanceCriteria.trim()) return null;
    const outcome = result.outcome?.trim() || task.outcome.trim();
    const acceptanceCriteria = result.acceptanceCriteria?.trim() || task.acceptanceCriteria.trim();
    if (!outcome || !acceptanceCriteria) {
      throw badRequest('The first agent result for a task must define its outcome and acceptance criteria');
    }
    return { outcome, acceptanceCriteria };
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

  /** After a child changes, rebase the contiguous review-ready portion of the later PR stack. */
  private async enqueueStackRebase(userId: string, child: Task, dedupePrefix?: string): Promise<Job | null> {
    if (!child.parentTaskId || child.sequence === null || !child.branch) return null;
    const siblings = await this.repo.listSubtasks(userId, child.parentTaskId);
    const later: Task[] = [];
    for (const sibling of siblings.filter((candidate) => (candidate.sequence ?? 0) > child.sequence!).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
      if (TERMINAL_STATES.has(sibling.state)) continue;
      if (sibling.state === 'in-review' && sibling.prUrl && sibling.branch) {
        later.push(sibling);
        continue;
      }
      if (sibling.prUrl) {
        const workflow = await this.resolveWorkflow(userId, sibling);
        const step = workflow ? getStep(workflow, sibling.currentStepId) : null;
        if (step?.type === 'agent' && (step.output === 'review' || step.output === 'verdict')) {
          await this.repo.createEvent(userId, {
            taskId: sibling.id,
            type: 'stack-rebase-deferred',
            detail: { triggerTaskId: child.id },
            dedupeKey: dedupePrefix ? `${dedupePrefix}:${sibling.id}:deferred` : null,
          });
        }
      }
      break;
    }
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
      if (entry.ok) {
        const repository = job.payload.kind === 'rebase-stack' ? job.payload.repos[0] : undefined;
        if (repository && entry.headSha) {
          const pullRequest = (await this.repo.listPullRequests(userId, entry.taskId)).find((candidate) => candidate.repository === repository);
          if (pullRequest) {
            await this.repo.upsertPullRequest(userId, entry.taskId, {
              taskRepositoryId: pullRequest.taskRepositoryId,
              repository: pullRequest.repository,
              url: pullRequest.url,
              number: pullRequest.number,
              branch: pullRequest.branch,
              baseBranch: pullRequest.baseBranch,
              headSha: entry.headSha,
              status: pullRequest.status,
              mergedAt: pullRequest.mergedAt,
            });
          }
        }
        continue;
      }
      const sibling = await this.repo.getTask(userId, entry.taskId);
      if (!sibling || sibling.parentTaskId !== parent.id) continue;
      if (TERMINAL_STATES.has(sibling.state)) continue;
      const error = entry.error ?? `Rebase of ${entry.branch} failed`;
      await this.repo.updateTask(userId, sibling.id, { lastError: error });
      await this.repo.createMessage(userId, {
        taskId: sibling.id,
        role: 'agent',
        content: `Stack rebase failed: ${error}`,
        source: 'worker',
        externalId: `job:${job.id}:rebase:${sibling.id}:failure`,
      });
      if (entry.conflict && sibling.state !== 'failure') {
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
      if (sibling.state !== 'failure') {
        const fresh = (await this.repo.getTask(userId, sibling.id)) ?? sibling;
        await this.applyEvent(userId, fresh, UNIVERSAL_EVENTS.FAIL, {
          actor: 'system',
          detail: { jobId: job.id, reason: 'rebase' },
          idempotencyKey: `job:${job.id}:rebase:${sibling.id}:failure-transition`,
        });
      }
    }
    if (result.rebased.length > 0 && result.rebased.every((entry) => entry.ok) && await this.isCompletedRebaseGroup(userId, job)) {
      for (const entry of result.rebased) {
        const sibling = await this.repo.getTask(userId, entry.taskId);
        if (!sibling || sibling.parentTaskId !== parent.id || sibling.state !== 'in-review') continue;
        await this.applyEvent(userId, sibling, UNIVERSAL_EVENTS.RESTACKED, {
          actor: 'system',
          detail: { jobId: job.id, reason: 'stack-rebased' },
          idempotencyKey: `${this.rebaseGroupKey(job)}:${sibling.id}:review-invalidated`,
        });
      }
    }
    this.hub.publish(userId, { type: 'task.updated', taskId: parent.id });
  }

  private rebaseGroupKey(job: Job): string {
    if (!job.dedupeKey) return `job:${job.id}`;
    const separator = job.dedupeKey.lastIndexOf(':');
    return separator === -1 ? job.dedupeKey : job.dedupeKey.slice(0, separator);
  }

  /** The current applying job counts as complete; every other repository job must already have succeeded. */
  private async isCompletedRebaseGroup(userId: string, current: Job): Promise<boolean> {
    if (!current.dedupeKey) return true;
    const prefix = `${this.rebaseGroupKey(current)}:`;
    const group = (await this.repo.listJobsForTask(userId, current.taskId)).filter(
      (candidate) => candidate.kind === 'rebase-stack' && candidate.dedupeKey?.startsWith(prefix),
    );
    return group.every((candidate) => {
      if (candidate.id === current.id) return true;
      return candidate.status === 'completed' && candidate.result?.kind === 'rebase' && candidate.result.rebased.every((entry) => entry.ok);
    });
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
      await this.applyEvent(userId, task, UNIVERSAL_EVENTS.CONFLICT_RESOLVED, {
        actor: 'worker',
        detail: { jobId: job.id },
        idempotencyKey: `job:${job.id}:resolution-transition`,
      });
      await this.repo.updateTask(userId, task.id, { lastError: null });
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
    if (pullRequest.status !== status || pullRequest.mergedAt !== mergedAt) {
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
    }
    let task = await this.repo.getTask(pullRequest.userId, pullRequest.taskId);
    if (task && (task.state === 'in-review' || task.state === 'merge') && status === 'merged') {
      const all = await this.repo.listPullRequests(pullRequest.userId, pullRequest.taskId);
      if (all.length > 0 && all.every((item) => item.status === 'merged')) {
        await this.repo.cancelQueuedJobs(pullRequest.userId, pullRequest.taskId);
        if (task.state === 'in-review') {
          task = await this.applyEvent(pullRequest.userId, task, 'accept', {
            actor: 'system',
            detail: { reason: 'github-webhook' },
            idempotencyKey: `github-pr:${pullRequest.id}:all-merged:accept`,
            confirmedExternalMerge: true,
          });
        }
        if (task.state === 'merge') {
          await this.applyEvent(pullRequest.userId, task, 'complete', {
            actor: 'system',
            detail: { reason: 'github-webhook' },
            idempotencyKey: `github-pr:${pullRequest.id}:all-merged:complete`,
          });
        }
      }
    }
    this.hub.publish(pullRequest.userId, { type: 'task.updated', taskId: pullRequest.taskId });
    return true;
  }

  // ---------------------------------------------------------------- sweeper

  /** Requeue (or fail) jobs whose worker disappeared. Runs periodically from the app. */
  async sweepStaleJobs(now: Date = this.now()): Promise<{ requeued: number; failed: number }> {
    // Longer than Vercel's 300s hard deadline. A terminated invocation leaves a
    // lease that expires automatically, rather than permanently blocking recovery.
    const token = await this.repo.acquireMaintenanceLease('stale-jobs', 360);
    if (!token) return { requeued: 0, failed: 0 };
    try {
      return await this.recoverStaleJobs(now, Date.now() + 240_000);
    } finally {
      await this.repo.releaseMaintenanceLease('stale-jobs', token);
    }
  }

  private async recoverStaleJobs(now: Date, deadline: number): Promise<{ requeued: number; failed: number }> {
    let requeued = 0;
    let failed = 0;
    for (const job of await this.repo.listActiveJobs()) {
      if (Date.now() >= deadline) break; // Leave remaining work for the next cron invocation.
      if (job.status === 'applying') {
        const outcomeStartedAt = job.outcomeStartedAt ? Date.parse(job.outcomeStartedAt) : 0;
        if (outcomeStartedAt > now.getTime() - OUTCOME_LEASE_MS) continue;
        if (!job.outcomeHash || !job.outcomeToken || !job.leaseToken || (!job.result && !job.error)) {
          this.log.error({ userId: job.userId, taskId: job.taskId, jobId: job.id }, 'cannot recover job with incomplete outcome state');
          continue;
        }
        await this.repo.abandonJobOutcome(job.userId, job.id, job.attempt, job.outcomeHash, job.outcomeToken);
        if (job.result) await this.completeJob(job.userId, job.id, job.result, job.attempt, job.leaseToken);
        else await this.failJob(job.userId, job.id, job.error!, job.attempt, job.leaseToken);
        this.log.warn({ userId: job.userId, taskId: job.taskId, jobId: job.id, attempt: job.attempt }, 'resumed abandoned job outcome');
        continue;
      }
      const leaseExpiresAt = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : 0;
      if (leaseExpiresAt > now.getTime()) continue;
      this.metrics?.inc('sindral_lease_expiries_total', { kind: job.kind });
      if (job.attempt < MAX_JOB_ATTEMPTS) {
        const recovered = await this.repo.updateExpiredJob(job, now.toISOString(), { status: 'queued', workerId: null, claimedAt: null, leaseExpiresAt: null, attempt: job.attempt + 1 });
        if (!recovered) continue;
        requeued += 1;
        this.metrics?.inc('sindral_job_retries_total', { kind: job.kind });
        this.log.warn({ userId: job.userId, taskId: job.taskId, jobId: job.id, attempt: job.attempt + 1 }, 'requeued job from lost worker');
      } else {
        const error = 'Worker stopped responding and the job exhausted its retries';
        const recovered = await this.repo.updateExpiredJob(job, now.toISOString(), { status: 'failed', error, finishedAt: now.toISOString() });
        if (!recovered) continue;
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
