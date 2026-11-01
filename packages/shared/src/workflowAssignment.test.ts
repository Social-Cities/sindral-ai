import { describe, expect, it } from 'vitest';
import { FULL_SDLC_WORKFLOW } from './defaultWorkflows.js';
import { workflowPrerequisiteWarnings } from './workflowAssignment.js';
import { transitionToWorkflowStep } from './stateMachine.js';

const task = { state: 'failure', currentStepId: 'old', failedStepId: 'old' };

describe('workflow reassignment rules', () => {
  it('waits at a human step and dispatches the selected agent step', () => {
    expect(transitionToWorkflowStep(task, FULL_SDLC_WORKFLOW, 'plan-review')).toMatchObject({ nextState: 'plan-review', nextStepId: 'plan-review', failedStepId: null, effects: [] });
    expect(transitionToWorkflowStep(task, FULL_SDLC_WORKFLOW, 'implement')).toMatchObject({ nextState: 'implement', nextStepId: 'implement', failedStepId: null, effects: [{ type: 'dispatch', stepId: 'implement' }] });
  });

  it('rejects unknown steps, end steps and closed tasks', () => {
    expect(() => transitionToWorkflowStep(task, FULL_SDLC_WORKFLOW, 'unknown')).toThrow('Selected step does not exist');
    expect(() => transitionToWorkflowStep(task, FULL_SDLC_WORKFLOW, 'done')).toThrow('Choose a human or agent step');
    expect(() => transitionToWorkflowStep({ ...task, state: 'done' }, FULL_SDLC_WORKFLOW, 'todo')).toThrow('Reopen the task');
  });

  it('warns about missing prompt inputs and prior outputs without duplicates', () => {
    const step = FULL_SDLC_WORKFLOW.steps.find((item) => item.id === 'implement')!;
    const warnings = workflowPrerequisiteWarnings(FULL_SDLC_WORKFLOW, step, {}, []);
    expect(warnings.filter((item) => item.code === 'missing-plan')).toHaveLength(1);
    expect(workflowPrerequisiteWarnings(FULL_SDLC_WORKFLOW, step, { plan: '# Ready' }, ['plan']).some((item) => item.code === 'missing-plan')).toBe(false);
    const review = FULL_SDLC_WORKFLOW.steps.find((item) => item.id === 'adversarial-review')!;
    expect(workflowPrerequisiteWarnings(FULL_SDLC_WORKFLOW, review, {}, []).some((item) => item.code === 'missing-implementation')).toBe(true);
  });

  it('does not warn for human checkpoints or require planning before the planner runs', () => {
    expect(workflowPrerequisiteWarnings(FULL_SDLC_WORKFLOW, FULL_SDLC_WORKFLOW.steps.find((item) => item.id === 'plan-review')!, {}, [])).toEqual([]);
    expect(workflowPrerequisiteWarnings(FULL_SDLC_WORKFLOW, FULL_SDLC_WORKFLOW.steps.find((item) => item.id === 'planning')!, {}, []).some((item) => item.code === 'missing-plan')).toBe(false);
  });
});
