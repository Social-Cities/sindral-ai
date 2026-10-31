import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_DRIVEN_DESIGN_CONTRACT, type AgentJobPayload } from '@sindral/shared';
import { claimNext, completeNext, createTestApp, dddChecks, implementation, review, reviewSlice, type TestContext } from '../test/helpers.js';
import { toWorkflow } from './workflows.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestApp(); });
afterEach(async () => { await ctx.app.close(); });

describe('DDD requirements on existing code workflows', () => {
  it('injects DDD into legacy pinned prompts and rejects incomplete multi-repository verification', async () => {
    const workflows = ctx.app.ctx.workflows;
    const fast = (await workflows.list(ctx.userA)).find((workflow) => workflow.name === 'Fast Track')!;
    const definition = toWorkflow(fast);
    // Simulate a saved workflow that predates the current mandatory contract.
    definition.steps = definition.steps.map((step) => ({ ...step, ...(step.prompt ? { prompt: step.prompt.replace(DOMAIN_DRIVEN_DESIGN_CONTRACT, '') } : {}) }));
    await workflows.update(ctx.userA, fast.id, definition);
    const orch = ctx.app.ctx.orchestrator;
    let task = await orch.createTask(ctx.userA, { title: 'Domain policy', description: 'Enforce a business invariant', repos: ['acme/app', 'acme/api'], workflowId: fast.id });
    task = await orch.applyUserEvent(ctx.userA, task.id, 'start');
    expect(task.pinnedWorkflow!.steps.find((step) => step.id === 'implement')!.prompt).not.toContain(DOMAIN_DRIVEN_DESIGN_CONTRACT);
    const assertQueuedContract = async () => {
      const job = (await ctx.repo.listJobsForTask(ctx.userA, task.id)).find((job) => job.status === 'queued')!;
      const payload = job.payload as AgentJobPayload;
      expect(payload.step.prompt).toContain(DOMAIN_DRIVEN_DESIGN_CONTRACT);
      expect(payload.context.ddd_scopes).toBe('acme/app, acme/api');
    };
    await assertQueuedContract();
    await completeNext(ctx, ctx.userA, implementation());
    await assertQueuedContract();
    const sliced = reviewSlice();
    if (sliced.kind !== 'review-slice') throw new Error('Expected a review-slice fixture');
    await completeNext(ctx, ctx.userA, {
      ...sliced,
      slices: [...sliced.slices, { ...sliced.slices[0]!, repository: 'acme/api', commit: 'b'.repeat(40) }],
      pullRequests: [...sliced.pullRequests!, { ...sliced.pullRequests![0]!, repository: 'acme/api', prUrl: 'https://github.com/acme/api/pull/2', number: 2 }],
    });
    await assertQueuedContract();
    await completeNext(ctx, ctx.userA, review());
    await assertQueuedContract();
    const job = await claimNext(ctx, ctx.userA);
    const go = { kind: 'verdict' as const, verdict: 'GO' as const, summary: 'Ready', report: '# Readiness' };
    await expect(orch.completeJob(ctx.userA, job!.id, go, job!.attempt, job!.leaseToken)).rejects.toThrow(/DDD criterion/);
    await expect(orch.completeJob(ctx.userA, job!.id, { ...go, dddChecks: dddChecks(['acme/app']) }, job!.attempt, job!.leaseToken)).rejects.toThrow(/acme\/api/);
    expect((await orch.getTask(ctx.userA, task.id)).state).toBe('verify');
    await orch.completeJob(ctx.userA, job!.id, { ...go, dddChecks: dddChecks(['acme/app', 'acme/api']) }, job!.attempt, job!.leaseToken);
    expect((await orch.getTask(ctx.userA, task.id)).state).toBe('in-review');
  });
  it('keeps document tasks outside the code architecture contract', async () => {
    const document = (await ctx.app.ctx.workflows.list(ctx.userA)).find((workflow) => workflow.name === 'Document (non-code)')!;
    const orch = ctx.app.ctx.orchestrator;
    const task = await orch.createTask(ctx.userA, { title: 'Write a report', description: '', repos: [], workflowId: document.id });
    await orch.applyUserEvent(ctx.userA, task.id, 'start');
    const job = (await ctx.repo.listJobsForTask(ctx.userA, task.id)).find((job) => job.status === 'queued')!;
    expect((job.payload as AgentJobPayload).step.prompt).not.toContain(DOMAIN_DRIVEN_DESIGN_CONTRACT);
    expect((job.payload as AgentJobPayload).context.ddd_scopes).toBe('');
  });
});
