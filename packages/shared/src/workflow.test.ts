import { describe, expect, it } from 'vitest';
import { FULL_SDLC_WORKFLOW } from './defaultWorkflows.js';
import type { Workflow } from './types.js';
import { acceptsFeedback, changeWorkflowStepType, humanActions, snapshotWorkflow, validateWorkflow } from './workflow.js';
import { workflowSchema } from './schemas.js';

function minimal(): Workflow {
  return {
    id: 'wf-x',
    name: 'X',
    entryStepId: 'todo',
    steps: [
      { id: 'todo', type: 'human', label: 'Todo', state: 'todo' },
      { id: 'work', type: 'agent', label: 'Work', state: 'implement', engine: 'claude', model: 'm', prompt: 'p', output: 'pr' },
      { id: 'end', type: 'end', label: 'Done', state: 'done' },
    ],
    edges: [
      { from: 'todo', to: 'work', event: 'start' },
      { from: 'work', to: 'end', event: 'complete' },
    ],
  };
}

describe('validateWorkflow', () => {
  it('accepts a minimal valid workflow', () => {
    expect(validateWorkflow(minimal())).toEqual([]);
  });

  it('reports missing entry step, end step and dangling edges', () => {
    const w = minimal();
    w.entryStepId = 'missing';
    w.steps = w.steps.filter((s) => s.type !== 'end');
    w.edges.push({ from: 'work', to: 'ghost', event: 'x' });
    const paths = validateWorkflow(w).map((i) => i.path);
    expect(paths).toContain('entryStepId');
    expect(paths).toContain('steps');
    expect(paths).toContain('edges[2].to');
  });

  it('requires agent steps to have prompt, output, engine, model and a complete edge', () => {
    const w = minimal();
    w.steps[1] = { id: 'work', type: 'agent', label: 'Work', state: 'implement' };
    w.edges[1] = { from: 'work', to: 'end', event: 'finished' };
    const msgs = validateWorkflow(w).map((i) => i.message);
    expect(msgs).toContain('Agent steps need a prompt');
    expect(msgs).toContain('Agent steps need an output kind');
    expect(msgs).toContain('Agent steps need an engine');
    expect(msgs).toContain('Agent steps need a model');
    expect(msgs.some((m) => m.includes('"complete" edge'))).toBe(true);
  });

  it('rejects duplicate step ids, duplicate events, and edges leaving an end step', () => {
    const w = minimal();
    w.steps.push({ id: 'todo', type: 'human', label: 'Dup', state: 'todo' });
    w.edges.push({ from: 'todo', to: 'work', event: 'start' });
    w.edges.push({ from: 'end', to: 'todo', event: 'again' });
    const msgs = validateWorkflow(w).map((i) => i.message);
    expect(msgs).toContain('Duplicate step id "todo"');
    expect(msgs).toContain('Duplicate event "start" on step "todo"');
    expect(msgs).toContain('End steps cannot have outgoing edges');
  });

  it('requires the entry step to be human', () => {
    const w = minimal();
    w.entryStepId = 'work';
    expect(validateWorkflow(w).map((i) => i.message)).toContain('Entry step must be a human step');
  });
});

describe('graph helpers', () => {
  it('lists human actions excluding feedback', () => {
    expect(humanActions(FULL_SDLC_WORKFLOW, 'plan-review')).toEqual([{ event: 'approve', label: 'Approve Plan', toStepId: 'implement' }]);
    expect(acceptsFeedback(FULL_SDLC_WORKFLOW, 'plan-review')).toBe(true);
    expect(acceptsFeedback(FULL_SDLC_WORKFLOW, 'todo')).toBe(false);
  });

  it('snapshot is a deep copy', () => {
    const snap = snapshotWorkflow(FULL_SDLC_WORKFLOW);
    expect(snap).toEqual(FULL_SDLC_WORKFLOW);
    snap.steps[0]!.label = 'changed';
    expect(FULL_SDLC_WORKFLOW.steps[0]!.label).toBe('Todo');
  });

  it('bundled workflows satisfy the zod schema', () => {
    expect(workflowSchema.safeParse(FULL_SDLC_WORKFLOW).success).toBe(true);
  });
});

describe('changing workflow step types', () => {
  it('protects the human entry step', () => {
    expect(() => changeWorkflowStepType(minimal(), 'todo', 'agent')).toThrow('Entry step must be a human step');
    expect(() => changeWorkflowStepType(minimal(), 'todo', 'end')).toThrow('Entry step must be a human step');
  });

  it('removes agent settings and outgoing edges when converting to an end step', () => {
    const original = minimal();
    const changed = changeWorkflowStepType(original, 'work', 'end');
    expect(changed.steps[1]).toEqual({ id: 'work', type: 'end', label: 'Work', state: 'done' });
    expect(changed.edges).toEqual([{ from: 'todo', to: 'work', event: 'start' }]);
    expect(validateWorkflow(changed)).toEqual([]);
    expect(original.steps[1]?.type).toBe('agent');
    expect(original.edges).toHaveLength(2);
  });

  it('allows a human checkpoint to become an agent with required configuration highlighted', () => {
    const human = changeWorkflowStepType(minimal(), 'work', 'human');
    expect(human.steps[1]).not.toHaveProperty('engine');
    const agent = changeWorkflowStepType(human, 'work', 'agent');
    expect(agent.steps[1]).toMatchObject({ type: 'agent', engine: 'claude', output: 'document' });
    expect(validateWorkflow(agent).map((issue) => issue.message)).toEqual(['Agent steps need a prompt']);
  });
});
