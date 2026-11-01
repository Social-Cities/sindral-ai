import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FULL_SDLC_WORKFLOW, type Task, type WorkflowAssignmentPreview } from '@sindral/shared';
import { claimNext, completeNext, createTestApp, plan, reload, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestApp(); });
afterEach(async () => { await ctx.app.close(); });
const headers = () => ({ authorization: `Bearer ${ctx.tokenA}` });
const orch = () => ctx.app.ctx.orchestrator;
async function setup() {
  const task = await orch().createTask(ctx.userA, { title: 'Move me', description: '', repos: ['acme/app'] });
  const workflow = await ctx.app.ctx.workflows.create(ctx.userA, 'New process', FULL_SDLC_WORKFLOW.id);
  return { task, workflow };
}
function preview(task: Task, workflowId: string, stepId: string) {
  return ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/workflow-assignment/preview`, headers: headers(), payload: { workflowId, stepId } });
}
function move(task: Task, workflowId: string, stepId: string, acknowledgeWarnings = false, key = crypto.randomUUID()) {
  return ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/workflow-assignment`, headers: { ...headers(), 'idempotency-key': key }, payload: { workflowId, stepId, acknowledgeWarnings, expectedVersion: task.version } });
}

describe('workflow assignment API', () => {
  it('moves a started task to a human checkpoint, preserves work and cancels queued jobs', async () => {
    let { task } = await setup();
    const workflow = await ctx.app.ctx.workflows.create(ctx.userA, 'Destination', FULL_SDLC_WORKFLOW.id);
    await orch().applyUserEvent(ctx.userA, task.id, 'start');
    await ctx.repo.updateTask(ctx.userA, task.id, { plan: '# Keep this plan', lastError: 'Old failure' });
    task = await reload(ctx, ctx.userA, task);
    const response = await move(task, workflow.id, 'plan-review');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ task: Task }>().task).toMatchObject({ workflowId: workflow.id, state: 'plan-review', currentStepId: 'plan-review', failedStepId: null, lastError: null, plan: '# Keep this plan', pinnedWorkflow: { id: workflow.id } });
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id)).map((job) => job.status)).toEqual(['cancelled']);
    expect((await ctx.repo.listEvents(ctx.userA, task.id)).at(-1)?.type).toBe('workflow-reassigned');
  });

  it('dispatches the chosen engine/model and applies the agent result on the new workflow', async () => {
    const { task: original, workflow } = await setup();
    let task = original;
    const definition = { ...workflow, steps: workflow.steps.map((step) => step.id === 'planning' ? { ...step, engine: 'codex' as const, model: 'gpt-6.1-sol' } : step) };
    await ctx.app.ctx.workflows.update(ctx.userA, workflow.id, definition);
    const response = await move(task, workflow.id, 'planning');
    expect(response.statusCode).toBe(200);
    task = response.json<{ task: Task }>().task;
    const [job] = await ctx.repo.listJobsForTask(ctx.userA, task.id);
    expect(job?.payload).toMatchObject({ kind: 'agent', step: { id: 'planning', engine: 'codex', model: 'gpt-6.1-sol' } });
    await completeNext(ctx, ctx.userA, plan());
    expect((await reload(ctx, ctx.userA, task)).state).toBe('plan-review');
  });

  it('previews missing prerequisites and requires acknowledgement before dispatch', async () => {
    const { task, workflow } = await setup();
    const response = await preview(task, workflow.id, 'implement');
    expect(response.statusCode).toBe(200);
    expect(response.json<WorkflowAssignmentPreview>().warnings.some((warning) => warning.code === 'missing-plan')).toBe(true);
    expect((await move(task, workflow.id, 'implement')).json()).toMatchObject({ error: { code: 'WORKFLOW_PREREQUISITES' } });
    expect(await ctx.repo.listJobsForTask(ctx.userA, task.id)).toHaveLength(0);
    expect((await move(task, workflow.id, 'implement', true)).statusCode).toBe(200);
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id))[0]?.stepId).toBe('implement');
  });

  it('uses destination mobile scope when building the job context', async () => {
    const { task } = await setup();
    const mobile = (await ctx.app.ctx.workflows.list(ctx.userA)).find((workflow) => workflow.mobilePlatforms)!;
    const response = await move(task, mobile.id, 'bdd');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ task: Task }>().task.platforms).toEqual(['ios', 'android']);
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id))[0]?.payload).toMatchObject({ kind: 'agent', context: { mobile_platforms: 'ios, android' } });
  });

  it('blocks claimed work and stale requests without changing the task', async () => {
    const { task: original, workflow } = await setup();
    let task = original;
    await orch().applyUserEvent(ctx.userA, task.id, 'start');
    expect((await move(task, workflow.id, 'todo')).statusCode).toBe(409);
    task = await reload(ctx, ctx.userA, task);
    await claimNext(ctx, ctx.userA);
    expect((await move(task, workflow.id, 'todo')).statusCode).toBe(409);
    expect((await reload(ctx, ctx.userA, task)).workflowId).toBe(task.workflowId);
  });

  it('replays a successful assignment without duplicating dispatch or events', async () => {
    const { task, workflow } = await setup();
    const key = crypto.randomUUID();
    const first = await move(task, workflow.id, 'planning', false, key);
    const second = await move(task, workflow.id, 'planning', false, key);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await ctx.repo.listJobsForTask(ctx.userA, task.id)).toHaveLength(1);
    expect((await ctx.repo.listEvents(ctx.userA, task.id)).filter((event) => event.type === 'workflow-reassigned')).toHaveLength(1);
    expect((await move(task, workflow.id, 'todo', false, key)).statusCode).toBe(409);
  });

  it('rejects inaccessible workflows, unknown steps, end steps and cross-tenant tasks', async () => {
    const { task, workflow } = await setup();
    const foreign = await ctx.app.ctx.workflows.create(ctx.userB, 'Private');
    expect((await preview(task, foreign.id, 'todo')).statusCode).toBe(404);
    expect((await move(task, foreign.id, 'todo')).statusCode).toBe(404);
    for (const stepId of ['unknown', 'done']) expect((await move(task, workflow.id, stepId)).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/workflow-assignment/preview`, headers: { authorization: `Bearer ${ctx.tokenB}` }, payload: { workflowId: foreign.id } })).statusCode).toBe(404);
  });
});
