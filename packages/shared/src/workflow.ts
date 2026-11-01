import type { Workflow, WorkflowEdge, WorkflowStep } from './types.js';
import { MODEL_OPTIONS } from './defaultWorkflows.js';

export interface WorkflowValidationIssue {
  path: string;
  message: string;
}

export const FEEDBACK_EVENT = 'feedback';
export const COMPLETE_EVENT = 'complete';
export const REJECT_EVENT = 'reject';
export const START_EVENT = 'start';

export function getStep(workflow: Workflow, stepId: string | null | undefined): WorkflowStep | null {
  if (!stepId) return null;
  return workflow.steps.find((s) => s.id === stepId) ?? null;
}

export function outgoingEdges(workflow: Workflow, stepId: string): WorkflowEdge[] {
  return workflow.edges.filter((e) => e.from === stepId);
}

export function findEdge(workflow: Workflow, stepId: string, event: string): WorkflowEdge | null {
  return workflow.edges.find((e) => e.from === stepId && e.event === event) ?? null;
}

/** Button-style actions available to a user on a human step (everything except chat feedback). */
export function humanActions(workflow: Workflow, stepId: string): { event: string; label: string; toStepId: string }[] {
  return outgoingEdges(workflow, stepId)
    .filter((e) => e.event !== FEEDBACK_EVENT)
    .map((e) => ({ event: e.event, label: e.label ?? e.event, toStepId: e.to }));
}

/** Whether a chat message on this step should trigger an agent revision cycle. */
export function acceptsFeedback(workflow: Workflow, stepId: string): boolean {
  return findEdge(workflow, stepId, FEEDBACK_EVENT) !== null;
}

/** The ordered "happy path": entry step followed by `complete`/first non-feedback edges until an end step. */
export function happyPath(workflow: Workflow): WorkflowStep[] {
  const path: WorkflowStep[] = [];
  const seen = new Set<string>();
  let current = getStep(workflow, workflow.entryStepId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    if (current.type === 'end') break;
    const edges = outgoingEdges(workflow, current.id);
    const preferred =
      edges.find((e) => e.event === COMPLETE_EVENT) ??
      edges.find((e) => e.event === START_EVENT) ??
      edges.find((e) => e.event !== FEEDBACK_EVENT && e.event !== REJECT_EVENT && !seen.has(e.to)) ??
      null;
    current = preferred ? getStep(workflow, preferred.to) : null;
  }
  return path;
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export function validateWorkflow(workflow: Workflow): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  if (!workflow.name?.trim()) issues.push({ path: 'name', message: 'Workflow name is required' });
  if (workflow.steps.length === 0) issues.push({ path: 'steps', message: 'At least one step is required' });

  const ids = new Set<string>();
  workflow.steps.forEach((step, i) => {
    const p = `steps[${i}]`;
    if (!ID_RE.test(step.id)) issues.push({ path: `${p}.id`, message: `Invalid step id "${step.id}"` });
    if (ids.has(step.id)) issues.push({ path: `${p}.id`, message: `Duplicate step id "${step.id}"` });
    ids.add(step.id);
    if (!step.label?.trim()) issues.push({ path: `${p}.label`, message: 'Step label is required' });
    if (!step.state?.trim()) issues.push({ path: `${p}.state`, message: 'Step state is required' });
    if (step.type === 'agent') {
      if (step.output === 'design' && (step.engine !== 'claude' || step.resumeSessionKey !== 'design')) {
        issues.push({ path: `${p}.output`, message: 'Design steps require the Claude engine and the design resume session key' });
      }
      if (!step.output) issues.push({ path: `${p}.output`, message: 'Agent steps need an output kind' });
      if (step.output !== 'merge') {
        if (!step.prompt?.trim()) issues.push({ path: `${p}.prompt`, message: 'Agent steps need a prompt' });
        if (!step.engine) issues.push({ path: `${p}.engine`, message: 'Agent steps need an engine' });
        if (!step.model?.trim()) issues.push({ path: `${p}.model`, message: 'Agent steps need a model' });
      }
    }
  });

  const entry = getStep(workflow, workflow.entryStepId);
  if (!entry) issues.push({ path: 'entryStepId', message: 'Entry step does not exist' });
  else if (entry.type !== 'human') issues.push({ path: 'entryStepId', message: 'Entry step must be a human step' });

  if (!workflow.steps.some((s) => s.type === 'end')) {
    issues.push({ path: 'steps', message: 'Workflow needs an end step' });
  }

  const edgeKeys = new Set<string>();
  workflow.edges.forEach((edge, i) => {
    const p = `edges[${i}]`;
    if (!ids.has(edge.from)) issues.push({ path: `${p}.from`, message: `Unknown step "${edge.from}"` });
    if (!ids.has(edge.to)) issues.push({ path: `${p}.to`, message: `Unknown step "${edge.to}"` });
    if (!edge.event?.trim()) issues.push({ path: `${p}.event`, message: 'Edge event is required' });
    const key = `${edge.from}:${edge.event}`;
    if (edgeKeys.has(key)) issues.push({ path: `${p}.event`, message: `Duplicate event "${edge.event}" on step "${edge.from}"` });
    edgeKeys.add(key);
    const from = getStep(workflow, edge.from);
    if (from?.type === 'end') issues.push({ path: `${p}.from`, message: 'End steps cannot have outgoing edges' });
  });

  for (const step of workflow.steps) {
    if (step.type === 'end') continue;
    const out = outgoingEdges(workflow, step.id);
    if (out.length === 0) issues.push({ path: `steps.${step.id}`, message: `Step "${step.label}" has no outgoing edges` });
    if (step.type === 'agent' && !out.some((e) => e.event === COMPLETE_EVENT)) {
      issues.push({ path: `steps.${step.id}`, message: `Agent step "${step.label}" needs a "complete" edge` });
    }
  }

  if (workflow.troubleshootStep) {
    const ts = workflow.troubleshootStep;
    if (ts.type !== 'agent' || ts.output !== 'troubleshoot') {
      issues.push({ path: 'troubleshootStep', message: 'Troubleshoot step must be an agent step with output "troubleshoot"' });
    }
  }
  return issues;
}

/** Structured deep copy used when pinning a workflow to a task. */
export function snapshotWorkflow(workflow: Workflow): Workflow {
  return JSON.parse(JSON.stringify(workflow)) as Workflow;
}

/** Change a step's role while keeping its identity and connections consistent. */
export function changeWorkflowStepType(workflow: Workflow, stepId: string, type: WorkflowStep['type']): Workflow {
  const step = getStep(workflow, stepId);
  if (!step) throw new Error('Step does not exist');
  if (step.type === type) return workflow;
  if (step.id === workflow.entryStepId && type !== 'human') throw new Error('Entry step must be a human step');
  const replacement: WorkflowStep = { id: step.id, label: step.label, state: type === 'end' ? 'done' : step.state, type };
  if (step.position) replacement.position = { ...step.position };
  if (type === 'agent') {
    Object.assign(replacement, { engine: 'claude', model: MODEL_OPTIONS.claude[0], mode: 'normal', output: 'document', prompt: '' });
  }
  return {
    ...workflow,
    steps: workflow.steps.map((item) => item.id === stepId ? replacement : item),
    edges: type === 'end' ? workflow.edges.filter((edge) => edge.from !== stepId) : workflow.edges,
  };
}

export function stepState(workflow: Workflow, stepId: string | null): string | null {
  return getStep(workflow, stepId)?.state ?? null;
}
