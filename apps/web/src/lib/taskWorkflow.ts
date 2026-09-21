import type { Task, Workflow, WorkflowStep } from '@sindral/shared';
import { getStep } from '@sindral/shared';

/**
 * Resolve the workflow a task runs on: the pinned snapshot when one exists,
 * otherwise the live workflow referenced by `workflowId`.
 */
export function resolveWorkflow(task: Pick<Task, 'pinnedWorkflow' | 'workflowId'>, workflows: readonly Workflow[]): Workflow | null {
  if (task.pinnedWorkflow) return task.pinnedWorkflow;
  if (task.workflowId) return workflows.find((w) => w.id === task.workflowId) ?? null;
  return null;
}

/** The step the task currently sits on, if resolvable. */
export function currentStep(task: Pick<Task, 'currentStepId' | 'pinnedWorkflow' | 'workflowId'>, workflows: readonly Workflow[]): WorkflowStep | null {
  const wf = resolveWorkflow(task, workflows);
  if (!wf) return null;
  return getStep(wf, task.currentStepId ?? wf.entryStepId);
}
