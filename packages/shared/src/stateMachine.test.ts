import { describe, expect, it } from 'vitest';
import { FULL_SDLC_WORKFLOW, FAST_TRACK_WORKFLOW, PLANNING_ONLY_WORKFLOW, DOCUMENT_WORKFLOW, BUNDLED_WORKFLOWS } from './defaultWorkflows.js';
import { availableActions, chatTriggersFeedback, eventForResult, isAgentActive, transition, TransitionError } from './stateMachine.js';
import { happyPath, validateWorkflow } from './workflow.js';

const wf = FULL_SDLC_WORKFLOW;
const at = (state: string, currentStepId: string | null, failedStepId: string | null = null) => ({ state, currentStepId, failedStepId });

describe('bundled workflows', () => {
  it.each(BUNDLED_WORKFLOWS.map((w) => [w.name, w] as const))('%s is valid', (_name, w) => {
    expect(validateWorkflow(w)).toEqual([]);
  });

  it('full sdlc happy path matches the engineering plan', () => {
    expect(happyPath(wf).map((s) => s.state)).toEqual([
      'todo', 'planning', 'plan-review', 'implement', 'adversarial-review', 'verify', 'in-review', 'merge', 'done',
    ]);
  });

  it('other workflows have sensible happy paths', () => {
    expect(happyPath(PLANNING_ONLY_WORKFLOW).map((s) => s.state)).toEqual(['todo', 'planning', 'plan-review', 'done']);
    expect(happyPath(FAST_TRACK_WORKFLOW).map((s) => s.state)).toEqual(['todo', 'implement', 'verify', 'in-review', 'merge', 'done']);
    expect(happyPath(DOCUMENT_WORKFLOW).map((s) => s.state)).toEqual(['todo', 'implement', 'in-review', 'done']);
  });
});

describe('transition', () => {
  it('starts planning and dispatches the planning agent', () => {
    const t = transition(at('todo', 'todo'), wf, 'start');
    expect(t.nextState).toBe('planning');
    expect(t.nextStepId).toBe('planning');
    expect(t.effects).toEqual([{ type: 'dispatch', stepId: 'planning' }]);
  });

  it('uses the entry step when the task has no current step yet', () => {
    const t = transition(at('todo', null), wf, 'start');
    expect(t.nextStepId).toBe('planning');
  });

  it('planning complete moves to plan review without effects', () => {
    const t = transition(at('planning', 'planning'), wf, 'complete');
    expect(t).toMatchObject({ nextState: 'plan-review', nextStepId: 'plan-review', effects: [] });
  });

  it('feedback on plan review dispatches the revision agent and returns to review', () => {
    const t = transition(at('plan-review', 'plan-review'), wf, 'feedback');
    expect(t).toMatchObject({ nextState: 'planning-feedback', effects: [{ type: 'dispatch', stepId: 'planning-feedback' }] });
    const back = transition(at('planning-feedback', 'planning-feedback'), wf, 'complete');
    expect(back.nextState).toBe('plan-review');
  });

  it('approve moves to implement, then review, verify, in-review, merge, done', () => {
    let t = transition(at('plan-review', 'plan-review'), wf, 'approve');
    expect(t.nextState).toBe('implement');
    t = transition(at('implement', 'implement'), wf, 'complete');
    expect(t.nextState).toBe('adversarial-review');
    t = transition(at('adversarial-review', 'adversarial-review'), wf, 'complete');
    expect(t.nextState).toBe('verify');
    t = transition(at('verify', 'verify'), wf, 'complete');
    expect(t.nextState).toBe('in-review');
    t = transition(at('in-review', 'in-review'), wf, 'accept');
    expect(t).toMatchObject({ nextState: 'merge', nextStepId: 'merge', effects: [{ type: 'dispatch' }] });
    t = transition(at('merge', 'merge'), wf, 'complete');
    expect(t).toMatchObject({ nextState: 'done', nextStepId: 'done', effects: [{ type: 'complete-task' }] });
  });

  it('verify NO_GO rejects back to implement feedback', () => {
    const t = transition(at('verify', 'verify'), wf, 'reject');
    expect(t).toMatchObject({ nextState: 'implement-feedback', effects: [{ type: 'dispatch', stepId: 'implement-feedback' }] });
  });

  it('in-review feedback re-enters the review loop', () => {
    const t = transition(at('in-review', 'in-review'), wf, 'feedback');
    expect(t.nextState).toBe('implement-feedback');
    const next = transition(at('implement-feedback', 'implement-feedback'), wf, 'complete');
    expect(next.nextState).toBe('adversarial-review');
  });

  it('rejects invalid events', () => {
    expect(() => transition(at('plan-review', 'plan-review'), wf, 'accept')).toThrow(TransitionError);
    expect(() => transition(at('done', 'done'), wf, 'start')).toThrow(/already closed/);
    expect(() => transition(at('planning', 'nope'), wf, 'complete')).toThrow(TransitionError);
  });

  it('lets a user close an active task as done or wont-do and keeps terminal tasks closed', () => {
    expect(transition(at('implement', 'implement'), wf, 'mark-done')).toMatchObject({
      nextState: 'done',
      nextStepId: 'done',
      failedStepId: null,
      effects: [{ type: 'complete-task' }],
    });
    expect(transition(at('planning', 'planning'), wf, 'mark-wont-do')).toMatchObject({
      nextState: 'wont-do',
      nextStepId: 'planning',
      failedStepId: null,
      effects: [{ type: 'complete-task' }],
    });
    expect(() => transition(at('done', 'done'), wf, 'fail')).toThrow(/already closed/);
    expect(() => transition(at('wont-do', 'planning'), wf, 'start')).toThrow(/already closed/);
  });

  it('fail parks the task in failure and remembers the failed step', () => {
    const t = transition(at('implement', 'implement'), wf, 'fail');
    expect(t).toMatchObject({ nextState: 'failure', nextStepId: 'implement', failedStepId: 'implement', effects: [] });
  });

  it('troubleshoot dispatches the troubleshoot agent and resolved retries the failed step', () => {
    const ts = transition(at('failure', 'implement', 'implement'), wf, 'troubleshoot');
    expect(ts).toMatchObject({ nextState: 'troubleshoot', effects: [{ type: 'dispatch-troubleshoot', failedStepId: 'implement' }] });
    const resolved = transition(at('troubleshoot', 'implement', 'implement'), wf, 'resolved');
    expect(resolved).toMatchObject({ nextState: 'implement', nextStepId: 'implement', failedStepId: null, effects: [{ type: 'dispatch', stepId: 'implement' }] });
    const unresolved = transition(at('troubleshoot', 'implement', 'implement'), wf, 'unresolved');
    expect(unresolved).toMatchObject({ nextState: 'failure', failedStepId: 'implement' });
  });

  it('a troubleshoot agent failing keeps the original failed step', () => {
    const t = transition(at('troubleshoot', 'implement', 'implement'), wf, 'fail');
    expect(t).toMatchObject({ nextState: 'failure', failedStepId: 'implement' });
  });

  it('parks a task during conflict resolution and re-runs review before merge', () => {
    const conflict = transition(at('in-review', 'in-review'), wf, 'rebase-conflict');
    expect(conflict).toMatchObject({ nextState: 'conflict-resolution', nextStepId: 'in-review', failedStepId: 'in-review', effects: [] });
    const resolved = transition(at('conflict-resolution', 'in-review', 'in-review'), wf, 'conflict-resolved');
    expect(resolved).toMatchObject({ nextState: 'adversarial-review', nextStepId: 'adversarial-review', failedStepId: null, effects: [{ type: 'dispatch', stepId: 'adversarial-review' }] });
    const escalated = transition(at('conflict-resolution', 'in-review', 'in-review'), wf, 'conflict-escalated');
    expect(escalated).toMatchObject({ nextState: 'failure', failedStepId: 'in-review' });
  });

  it('retry from failure re-dispatches the failed step', () => {
    const t = transition(at('failure', 'planning', 'planning'), wf, 'retry');
    expect(t).toMatchObject({ nextState: 'planning', effects: [{ type: 'dispatch', stepId: 'planning' }] });
    expect(() => transition(at('failure', 'planning', 'planning'), wf, 'approve')).toThrow(TransitionError);
  });
});

describe('ui helpers', () => {
  it('offers human actions on human steps only', () => {
    expect(availableActions(at('todo', 'todo'), wf).map((a) => a.event)).toEqual(['start', 'mark-done', 'mark-wont-do']);
    expect(availableActions(at('plan-review', 'plan-review'), wf).map((a) => a.event)).toEqual(['approve', 'mark-done', 'mark-wont-do']);
    expect(availableActions(at('in-review', 'in-review'), wf).map((a) => a.event)).toEqual(['accept', 'mark-done', 'mark-wont-do']);
    expect(availableActions(at('implement', 'implement'), wf).map((a) => a.event)).toEqual(['mark-done', 'mark-wont-do']);
    expect(availableActions(at('failure', 'implement', 'implement'), wf).map((a) => a.event)).toEqual(['troubleshoot', 'retry', 'mark-done', 'mark-wont-do']);
    expect(availableActions(at('todo', null), null).map((a) => a.event)).toEqual(['mark-done', 'mark-wont-do']);
    expect(availableActions(at('done', 'done'), wf)).toEqual([]);
    expect(availableActions(at('wont-do', 'planning'), wf)).toEqual([]);
  });

  it('chat triggers feedback only on gates with a feedback edge', () => {
    expect(chatTriggersFeedback(at('plan-review', 'plan-review'), wf)).toBe(true);
    expect(chatTriggersFeedback(at('in-review', 'in-review'), wf)).toBe(true);
    expect(chatTriggersFeedback(at('todo', 'todo'), wf)).toBe(false);
    expect(chatTriggersFeedback(at('implement', 'implement'), wf)).toBe(false);
    expect(chatTriggersFeedback(at('failure', 'implement', 'implement'), wf)).toBe(false);
  });

  it('maps results to events', () => {
    expect(eventForResult({ kind: 'plan', summary: '', plan: '' })).toBe('complete');
    expect(eventForResult({ kind: 'verdict', summary: '', report: '', verdict: 'GO' })).toBe('complete');
    expect(eventForResult({ kind: 'verdict', summary: '', report: '', verdict: 'NO_GO' })).toBe('reject');
    expect(eventForResult({ kind: 'troubleshoot', summary: '', diagnosis: '', resolved: true })).toBe('resolved');
    expect(eventForResult({ kind: 'troubleshoot', summary: '', diagnosis: '', resolved: false })).toBe('unresolved');
  });

  it('knows when an agent is active', () => {
    expect(isAgentActive(at('planning', 'planning'), wf)).toBe(true);
    expect(isAgentActive(at('plan-review', 'plan-review'), wf)).toBe(false);
    expect(isAgentActive(at('troubleshoot', 'implement', 'implement'), wf)).toBe(true);
    expect(isAgentActive(at('conflict-resolution', 'in-review', 'in-review'), wf)).toBe(true);
    expect(isAgentActive(at('failure', 'implement', 'implement'), wf)).toBe(false);
  });
});
