import type { JobContext, StepOutputKind, Workflow, WorkflowStep } from './types.js';
import { happyPath } from './workflow.js';

export interface WorkflowPrerequisiteWarning {
  code: string;
  message: string;
}

export interface WorkflowAssignmentPreview {
  workflow: Workflow;
  step: WorkflowStep;
  warnings: WorkflowPrerequisiteWarning[];
  expectedVersion: number;
}

const CONTEXT_LABELS: Partial<Record<keyof JobContext, string>> = {
  plan: 'Implementation plan', bdd_plan: 'BDD plan', review: 'Review report', review_slices: 'Review slices',
  verify_report: 'Verification report', pr_url: 'Pull request', platform_implementations: 'Prior platform implementations',
  error: 'Error details',
};

/** Missing prompt inputs and outputs normally produced before this step. Warnings may be overridden. */
export function workflowPrerequisiteWarnings(workflow: Workflow, step: WorkflowStep, context: Partial<JobContext>, completedOutputs: readonly StepOutputKind[], repositories?: readonly string[]): WorkflowPrerequisiteWarning[] {
  if (step.type !== 'agent') return [];
  const warnings = new Map<string, WorkflowPrerequisiteWarning>();
  const add = (code: string, message: string) => warnings.set(code, { code, message });
  if (repositories?.length === 0 && ['implementation', 'pr', 'review-slice', 'review', 'verdict', 'merge', 'conflict-resolution'].includes(step.output ?? '')) {
    add('missing-repositories', 'No repositories are assigned to this task. This step normally works with repository code.');
  }
  const path = happyPath(workflow);
  const index = path.findIndex((item) => item.id === step.id);
  const previousSteps = index < 0 ? [] : path.slice(0, index);
  const ownOutput: Partial<Record<StepOutputKind, string>> = { plan: 'plan', 'bdd-plan': 'bdd_plan', review: 'review', verdict: 'verify_report', 'review-slice': 'review_slices' };
  for (const match of (step.prompt ?? '').matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
    const key = match[1] as keyof JobContext;
    // Plans and reports can include a previous version when revising; it is optional on their first run.
    if (step.output && ownOutput[step.output] === key) continue;
    if ((step.output === 'plan' || step.output === 'bdd-plan') && (key === 'plan' || key === 'bdd_plan')) continue;
    if (key === 'platform_implementations' && !previousSteps.some((item) => item.platform)) continue;
    const label = CONTEXT_LABELS[key];
    const value = context[key];
    if (label && (typeof value !== 'string' || !value.trim())) add(`missing-${key}`, `${label} is missing, but this agent's prompt uses it.`);
  }
  const available: Partial<Record<StepOutputKind, boolean>> = {
    plan: Boolean(context.plan?.trim()), 'bdd-plan': Boolean(context.bdd_plan?.trim()),
    review: Boolean(context.review?.trim()), 'review-slice': Boolean(context.review_slices?.trim()),
    pr: Boolean(context.pr_url?.trim()), verdict: Boolean(context.verify_report?.trim()),
  };
  const codes: Partial<Record<StepOutputKind, string>> = { plan: 'plan', 'bdd-plan': 'bdd_plan', review: 'review', 'review-slice': 'review_slices', pr: 'pr_url', verdict: 'verify_report' };
  for (const previous of previousSteps) {
    if (previous.type !== 'agent' || !previous.output) continue;
    if (available[previous.output] ?? completedOutputs.includes(previous.output)) continue;
    const key = codes[previous.output] ?? previous.output;
    add(`missing-${key}`, `No ${previous.label} output is available. This step normally runs earlier in the workflow.`);
  }
  if (step.output === 'merge' && !context.pr_url?.trim()) add('missing-pr_url', 'No pull request is available to merge.');
  return [...warnings.values()];
}
