import type { AgentResult, Task, Workflow, WorkflowStep } from './types.js';
import { COMPLETE_EVENT, FEEDBACK_EVENT, REJECT_EVENT, findEdge, getStep, humanActions } from './workflow.js';

export type TransitionEffect =
  | { type: 'dispatch'; stepId: string }
  | { type: 'dispatch-troubleshoot'; failedStepId: string }
  | { type: 'complete-task' };

export interface Transition {
  nextState: string;
  nextStepId: string | null;
  failedStepId: string | null;
  effects: TransitionEffect[];
  event: string;
}

export class TransitionError extends Error {
  constructor(message: string, readonly code: 'INVALID_EVENT' | 'NO_WORKFLOW' | 'NO_STEP' = 'INVALID_EVENT') {
    super(message);
    this.name = 'TransitionError';
  }
}

type TaskLike = Pick<Task, 'state' | 'currentStepId' | 'failedStepId'>;

/** Universal events available regardless of workflow definition. */
export const UNIVERSAL_EVENTS = {
  MARK_DONE: 'mark-done',
  MARK_WONT_DO: 'mark-wont-do',
  FAIL: 'fail',
  TROUBLESHOOT: 'troubleshoot',
  RETRY: 'retry',
  RESOLVED: 'resolved',
  UNRESOLVED: 'unresolved',
  REBASE_CONFLICT: 'rebase-conflict',
  RESTACKED: 'restacked',
  CONFLICT_RESOLVED: 'conflict-resolved',
  CONFLICT_ESCALATED: 'conflict-escalated',
} as const;

function enterStep(step: WorkflowStep): { state: string; effects: TransitionEffect[] } {
  if (step.type === 'agent') return { state: step.state, effects: [{ type: 'dispatch', stepId: step.id }] };
  if (step.type === 'end') return { state: 'done', effects: [{ type: 'complete-task' }] };
  return { state: step.state, effects: [] };
}

/**
 * Pure transition function. Given the task, its pinned workflow and an event,
 * returns the next state and side effects the orchestrator must perform.
 */
export function transition(task: TaskLike, workflow: Workflow | null, event: string): Transition {
  if (task.state === 'done' || task.state === 'wont-do') {
    throw new TransitionError('Task is already closed');
  }

  if (event === UNIVERSAL_EVENTS.MARK_DONE) {
    const endStep = workflow?.steps.find((step) => step.type === 'end');
    return {
      nextState: 'done',
      nextStepId: endStep?.id ?? task.currentStepId,
      failedStepId: null,
      effects: [{ type: 'complete-task' }],
      event,
    };
  }

  if (event === UNIVERSAL_EVENTS.MARK_WONT_DO) {
    return {
      nextState: 'wont-do',
      nextStepId: task.currentStepId,
      failedStepId: null,
      effects: [{ type: 'complete-task' }],
      event,
    };
  }

  if (!workflow) throw new TransitionError('Task has no workflow', 'NO_WORKFLOW');

  if (event === UNIVERSAL_EVENTS.RESTACKED) {
    if (task.state !== 'in-review') throw new TransitionError('Only a task in implementation review can be restacked');
    const validationStep = workflow.steps.find((step) => step.type === 'agent' && step.output === 'review')
      ?? workflow.steps.find((step) => step.type === 'agent' && step.output === 'verdict');
    if (!validationStep) throw new TransitionError('Task workflow has no review or verification step to rerun', 'NO_STEP');
    const entered = enterStep(validationStep);
    return { nextState: entered.state, nextStepId: validationStep.id, failedStepId: null, effects: entered.effects, event };
  }

  if (event === UNIVERSAL_EVENTS.REBASE_CONFLICT) {
    if (!task.currentStepId || task.state === 'done' || task.state === 'failure' || task.state === 'troubleshoot' || task.state === 'conflict-resolution') {
      throw new TransitionError('Task cannot enter conflict resolution from its current state');
    }
    return {
      nextState: 'conflict-resolution',
      nextStepId: task.currentStepId,
      failedStepId: task.currentStepId,
      effects: [],
      event,
    };
  }

  if (task.state === 'conflict-resolution') {
    const resumeStepId = task.failedStepId ?? task.currentStepId;
    if (!resumeStepId) throw new TransitionError('Conflict-resolution task has no step to resume', 'NO_STEP');
    if (event === UNIVERSAL_EVENTS.CONFLICT_RESOLVED) {
      const reviewStep = workflow.steps.find((step) => step.type === 'agent' && step.output === 'review');
      if (reviewStep) {
        const entered = enterStep(reviewStep);
        return { nextState: entered.state, nextStepId: reviewStep.id, failedStepId: null, effects: entered.effects, event };
      }
      const step = getStep(workflow, resumeStepId);
      if (!step) throw new TransitionError(`Unknown step ${resumeStepId}`, 'NO_STEP');
      return { nextState: step.state, nextStepId: step.id, failedStepId: null, effects: [], event };
    }
    if (event === UNIVERSAL_EVENTS.CONFLICT_ESCALATED) {
      return { nextState: 'failure', nextStepId: resumeStepId, failedStepId: resumeStepId, effects: [], event };
    }
    throw new TransitionError(`Event "${event}" is not valid during conflict resolution`);
  }

  // --- universal handling for failure/troubleshoot ---
  if (event === UNIVERSAL_EVENTS.FAIL) {
    const failedStepId = task.state === 'troubleshoot' ? task.failedStepId : task.currentStepId;
    return { nextState: 'failure', nextStepId: task.currentStepId, failedStepId: failedStepId ?? null, effects: [], event };
  }

  if (task.state === 'failure') {
    const failedStepId = task.failedStepId ?? task.currentStepId;
    if (!failedStepId) throw new TransitionError('Failed task has no step to recover to', 'NO_STEP');
    if (event === UNIVERSAL_EVENTS.TROUBLESHOOT) {
      return { nextState: 'troubleshoot', nextStepId: failedStepId, failedStepId, effects: [{ type: 'dispatch-troubleshoot', failedStepId }], event };
    }
    if (event === UNIVERSAL_EVENTS.RETRY) {
      const step = getStep(workflow, failedStepId);
      if (!step) throw new TransitionError(`Unknown step ${failedStepId}`, 'NO_STEP');
      const entered = enterStep(step);
      return { nextState: entered.state, nextStepId: step.id, failedStepId: null, effects: entered.effects, event };
    }
    throw new TransitionError(`Event "${event}" is not valid in failure state`);
  }

  if (task.state === 'troubleshoot') {
    const failedStepId = task.failedStepId ?? task.currentStepId;
    if (!failedStepId) throw new TransitionError('Troubleshooting task has no failed step', 'NO_STEP');
    if (event === UNIVERSAL_EVENTS.RESOLVED) {
      const step = getStep(workflow, failedStepId);
      if (!step) throw new TransitionError(`Unknown step ${failedStepId}`, 'NO_STEP');
      const entered = enterStep(step);
      return { nextState: entered.state, nextStepId: step.id, failedStepId: null, effects: entered.effects, event };
    }
    if (event === UNIVERSAL_EVENTS.UNRESOLVED) {
      return { nextState: 'failure', nextStepId: failedStepId, failedStepId, effects: [], event };
    }
    throw new TransitionError(`Event "${event}" is not valid while troubleshooting`);
  }

  // --- workflow-driven handling ---
  const currentStep = getStep(workflow, task.currentStepId ?? workflow.entryStepId);
  if (!currentStep) throw new TransitionError('Task is not on a valid workflow step', 'NO_STEP');
  if (currentStep.type === 'end') throw new TransitionError('Task is already complete');

  const edge = findEdge(workflow, currentStep.id, event);
  if (!edge) throw new TransitionError(`Event "${event}" is not valid on step "${currentStep.label}"`);
  const target = getStep(workflow, edge.to);
  if (!target) throw new TransitionError(`Edge target ${edge.to} does not exist`, 'NO_STEP');
  const entered = enterStep(target);
  return { nextState: entered.state, nextStepId: target.id, failedStepId: null, effects: entered.effects, event };
}

/** Actions the UI should offer for the task's current position. */
export function availableActions(task: TaskLike, workflow: Workflow | null): { event: string; label: string }[] {
  if (task.state === 'done' || task.state === 'wont-do') return [];
  const closeActions = [
    { event: UNIVERSAL_EVENTS.MARK_DONE, label: 'Mark done' },
    { event: UNIVERSAL_EVENTS.MARK_WONT_DO, label: "Won't do" },
  ];
  if (task.state === 'failure') {
    return [
      { event: UNIVERSAL_EVENTS.TROUBLESHOOT, label: 'Troubleshoot' },
      { event: UNIVERSAL_EVENTS.RETRY, label: 'Retry step' },
      ...closeActions,
    ];
  }
  if (task.state === 'troubleshoot' || !workflow) return closeActions;
  const step = getStep(workflow, task.currentStepId ?? workflow.entryStepId);
  if (!step || step.type !== 'human') return closeActions;
  return [...humanActions(workflow, step.id).map(({ event, label }) => ({ event, label })), ...closeActions];
}

/** Whether a chat message should kick off an agent revision on the task's current step. */
export function chatTriggersFeedback(task: TaskLike, workflow: Workflow | null): boolean {
  if (!workflow || task.state === 'failure' || task.state === 'troubleshoot' || task.state === 'done' || task.state === 'wont-do') return false;
  const step = getStep(workflow, task.currentStepId ?? workflow.entryStepId);
  if (!step || step.type !== 'human') return false;
  return findEdge(workflow, step.id, FEEDBACK_EVENT) !== null;
}

/** Map an agent result to the transition event it implies. */
export function eventForResult(result: AgentResult): string {
  switch (result.kind) {
    case 'verdict':
      return result.verdict === 'GO' ? COMPLETE_EVENT : REJECT_EVENT;
    case 'troubleshoot':
      return result.resolved ? UNIVERSAL_EVENTS.RESOLVED : UNIVERSAL_EVENTS.UNRESOLVED;
    default:
      return COMPLETE_EVENT;
  }
}

/** Whether an agent is expected to be running for a task in this state. */
export function isAgentActive(task: TaskLike, workflow: Workflow | null): boolean {
  if (task.state === 'troubleshoot' || task.state === 'conflict-resolution') return true;
  if (task.state === 'failure' || task.state === 'done' || task.state === 'wont-do' || !workflow) return false;
  const step = getStep(workflow, task.currentStepId);
  return step?.type === 'agent';
}
