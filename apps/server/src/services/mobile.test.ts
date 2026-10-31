import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentJobPayload, AppPlatform, BddPlanResult, Task } from '@sindral/shared';
import { claimNext, completeNext, createTestApp, dddChecks, implementation, plan, reload, review, reviewSlice, type TestContext } from '../test/helpers.js';

let ctx: TestContext;
const bdd: BddPlanResult = { kind: 'bdd-plan', summary: 'BDD designed', plan: '# BDD plan', scenarios: [{ id: 'BDD-1', given: 'Signed out', when: 'User signs in', then: 'Session is created' }], outcome: 'Users sign in.', acceptanceCriteria: '- Sign in works.' };
beforeEach(async () => { ctx = await createTestApp(); });
afterEach(async () => { await ctx.app.close(); });
const orch = () => ctx.app.ctx.orchestrator;
async function create(platforms: AppPlatform[] = ['ios', 'android', 'web'], selected?: AppPlatform[]) {
  const project = await ctx.repo.createProject(ctx.userA, { name: 'Mobile app', description: '', projectType: 'mobile-app', platforms, repositories: ['acme/app'] });
  return orch().createTask(ctx.userA, { title: 'Sign in', description: 'Add sign in', projectId: project.id, repos: [], ...(selected ? { platforms: selected } : {}) });
}
async function nextPayload(task: Task): Promise<AgentJobPayload> {
  const job = (await ctx.repo.listJobsForTask(ctx.userA, task.id)).find((job) => job.status === 'queued');
  expect(job).toBeDefined();
  return job!.payload as AgentJobPayload;
}
async function planned(task: Task) {
  await orch().applyUserEvent(ctx.userA, task.id, 'start');
  await completeNext(ctx, ctx.userA, bdd);
  expect((await nextPayload(task)).context.bdd_plan).toContain('BDD-1');
  await completeNext(ctx, ctx.userA, plan());
}

describe('mobile engineering orchestration', () => {
  for (let mask = 1; mask < 8; mask++) {
    const selected = (['ios', 'android', 'web'] as AppPlatform[]).filter((_, index) => mask & (1 << index));
    it(`runs only task-selected ${selected.join(', ')} through release checks and feedback`, async () => {
      const task = await create(['ios', 'android', 'web'], [...selected].reverse());
      expect(task.platforms).toEqual(selected);
      await planned(task);
      const scoped = await orch().resolveWorkflow(ctx.userA, await reload(ctx, ctx.userA, task));
      expect(scoped!.mobilePlatforms).toEqual(selected);
      expect(scoped!.steps.filter((step) => step.platform).every((step) => selected.includes(step.platform!))).toBe(true);
      await orch().applyUserEvent(ctx.userA, task.id, 'approve');
      for (const platform of selected) {
        const payload = await nextPayload(task);
        expect(payload.step.platform).toBe(platform);
        expect(payload.context.mobile_platforms).toBe(selected.join(', '));
        expect(payload.context.ddd_scopes).toBe([...selected, 'supabase'].join(', '));
        await completeNext(ctx, ctx.userA, implementation());
      }
      await completeNext(ctx, ctx.userA, reviewSlice());
      await completeNext(ctx, ctx.userA, review());
      await completeNext(ctx, ctx.userA, {
        kind: 'verdict', verdict: 'GO', summary: 'Ready', report: 'Selected clients verified',
        bddChecks: selected.map((platform) => ({ scenarioId: 'BDD-1', platform, command: `${platform} test`, status: 'passed', evidence: 'Scenario passed' })),
        dddChecks: dddChecks([...selected, 'supabase']),
      });
      expect((await reload(ctx, ctx.userA, task)).state).toBe('in-review');
      await orch().postUserMessage(ctx.userA, task.id, 'Fix the selected clients', 'web');
      for (const platform of selected) {
        expect((await nextPayload(task)).step.id).toBe(`implement-feedback-${platform}`);
        await completeNext(ctx, ctx.userA, implementation());
      }
      expect((await nextPayload(task)).step.id).toBe('review-slice');
    });
  }

  it('edits task scope before starting and keeps it independent of later project changes', async () => {
    let task = await create(['ios', 'android', 'web'], ['ios', 'web']);
    task = await orch().updateTask(ctx.userA, task.id, { platforms: ['android'] });
    task = await orch().updateTask(ctx.userA, task.id, { workflowId: task.workflowId! });
    expect(task.platforms).toEqual(['android']);
    expect((await orch().resolveWorkflow(ctx.userA, task))!.mobilePlatforms).toEqual(['android']);
    await ctx.repo.updateProject(ctx.userA, task.projectId!, { platforms: ['ios'] });
    await planned(task);
    await expect(orch().updateTask(ctx.userA, task.id, { platforms: ['ios'] })).rejects.toThrow(/todo/);
    await expect(ctx.repo.updateTask(ctx.userA, task.id, { platforms: ['ios'] })).rejects.toThrow(/locked/);
    await orch().applyUserEvent(ctx.userA, task.id, 'approve');
    expect((await nextPayload(task)).step.platform).toBe('android');
  });

  it('rejects unsupported, empty, duplicate and non-mobile platform selections', async () => {
    const task = await create(['ios'], ['ios']);
    const override = await orch().updateTask(ctx.userA, task.id, { platforms: ['web'] });
    expect(override.platforms).toEqual(['web']);
    for (const platforms of [['unknown'], [], ['ios', 'ios']] as AppPlatform[][]) {
      const response = await ctx.app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: { authorization: `Bearer ${ctx.tokenA}` }, payload: { platforms } });
      expect(response.statusCode).toBe(400);
    }
    const nonMobile = await orch().createTask(ctx.userA, { title: 'Standard', description: '', repos: ['acme/app'] });
    await expect(orch().updateTask(ctx.userA, nonMobile.id, { platforms: ['ios'] })).rejects.toThrow(/mobile app workflow/);
    const otherUser = await ctx.app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: { authorization: `Bearer ${ctx.tokenB}` }, payload: { platforms: ['ios'] } });
    expect(otherUser.statusCode).toBe(404);
  });

  it('persists defaults and platform edits through the owner-scoped API', async () => {
    const headers = { authorization: `Bearer ${ctx.tokenA}` };
    const created = await ctx.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Native app', projectType: 'mobile-app', repos: ['acme/app'] } });
    expect(created.statusCode).toBe(201);
    const project = created.json().project as { id: string; projectType: string; platforms: string[] };
    expect(project).toMatchObject({ projectType: 'mobile-app', platforms: ['ios', 'android'] });
    const url = `/api/projects/${project.id}`;
    const forbidden = await ctx.app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${ctx.tokenB}` }, payload: { platforms: ['web'] } });
    expect(forbidden.statusCode).toBe(404);
    const invalid = await ctx.app.inject({ method: 'PATCH', url, headers, payload: { repos: ['acme/app', 'acme/other'] } });
    expect(invalid.statusCode).toBe(400);
    const updated = await ctx.app.inject({ method: 'PATCH', url, headers, payload: { platforms: ['web'] } });
    expect(updated.json().project.platforms).toEqual(['web']);
    const task = await orch().createTask(ctx.userA, { title: 'Web app', description: '', repos: [], projectId: project.id });
    await orch().applyUserEvent(ctx.userA, task.id, 'start');
    expect((await reload(ctx, ctx.userA, task)).pinnedWorkflow!.mobilePlatforms).toEqual(['web']);
  });
  it('pins selected platforms, reviews two plans, and isolates ordered implementation sessions', async () => {
    const task = await create();
    await planned(task);
    const detail = await orch().getTaskWithRelations(ctx.userA, task.id);
    expect(detail.bddPlan).toEqual(bdd);
    expect(detail.plan).toBe('# Plan');
    expect(detail.artifacts.map((artifact) => artifact.name)).toContain('bdd-plan.md');
    await orch().applyUserEvent(ctx.userA, task.id, 'approve');
    for (const platform of ['ios', 'android', 'web']) {
      const payload = await nextPayload(task);
      expect(payload.step.platform).toBe(platform);
      expect(payload.step.resumeSessionKey).toBe(`implementation-${platform}`);
      expect(payload.resumeSessionId).toBeNull();
      expect(payload.context.plan).toBe('# Plan');
      expect(payload.context.bdd_plan).toContain('BDD-1');
      if (platform !== 'ios') expect(payload.context.platform_implementations).toContain('iOS API contract');
      const job = await claimNext(ctx, ctx.userA);
      await orch().completeJob(ctx.userA, job!.id, { ...implementation(), summary: platform === 'ios' ? 'iOS API contract' : `${platform} complete` }, job!.attempt, job!.leaseToken, `${platform}-session`);
    }
    expect((await nextPayload(task)).step.id).toBe('review-slice');
    await completeNext(ctx, ctx.userA, reviewSlice());
    await completeNext(ctx, ctx.userA, review());
    const verifier = await claimNext(ctx, ctx.userA);
    const go = { kind: 'verdict' as const, summary: 'Ready', report: 'BDD passed', verdict: 'GO' as const };
    await expect(orch().completeJob(ctx.userA, verifier!.id, go, verifier!.attempt, verifier!.leaseToken)).rejects.toThrow(/BDD scenario/);
    expect((await reload(ctx, ctx.userA, task)).state).toBe('verify');
    const bddChecks = (['ios', 'android', 'web'] as const).map((platform) => ({ scenarioId: 'BDD-1', platform, status: 'passed' as const, command: `${platform} test`, evidence: '1 scenario passed' }));
    await expect(orch().completeJob(ctx.userA, verifier!.id, { ...go, bddChecks }, verifier!.attempt, verifier!.leaseToken)).rejects.toThrow(/DDD criterion/);
    await orch().completeJob(ctx.userA, verifier!.id, { ...go, bddChecks, dddChecks: dddChecks(['ios', 'android', 'web', 'supabase']) }, verifier!.attempt, verifier!.leaseToken);
    expect((await reload(ctx, ctx.userA, task)).state).toBe('in-review');
    expect((await reload(ctx, ctx.userA, task)).pinnedWorkflow!.steps.find((step) => step.id === 'in-review')!.label).toBe('Ready for Release');
    await orch().postUserMessage(ctx.userA, task.id, 'Handle expired sessions', 'web');
    for (const platform of ['ios', 'android', 'web']) {
      const payload = await nextPayload(task);
      expect(payload.step.platform).toBe(platform);
      expect(payload.resumeSessionId).toBe(`${platform}-session`);
      expect(payload.context.feedback).toContain('Handle expired sessions');
      await completeNext(ctx, ctx.userA, implementation());
    }
    expect((await nextPayload(task)).step.output).toBe('review-slice');
  });
  it('routes BDD feedback independently, updates the implementation plan, and retains it separately', async () => {
    const task = await create(['android']);
    await planned(task);
    await orch().postUserMessage(ctx.userA, task.id, 'Add invalid login scenario', 'web', undefined, undefined, 'bdd');
    expect((await nextPayload(task)).step.id).toBe('bdd-feedback');
    await completeNext(ctx, ctx.userA, { ...bdd, plan: '# Revised BDD plan' });
    const reconcile = await nextPayload(task);
    expect(reconcile.step.id).toBe('planning-feedback');
    expect(reconcile.context.bdd_plan).toContain('Revised BDD');
    expect(reconcile.context.feedback).toContain('invalid login');
    await completeNext(ctx, ctx.userA, plan('# Reconciled plan'));
    await orch().postUserMessage(ctx.userA, task.id, 'Use existing repository', 'web', undefined, undefined, 'implementation');
    expect((await nextPayload(task)).step.id).toBe('planning-feedback');
    await completeNext(ctx, ctx.userA, plan('# Final plan'));
    await orch().applyUserEvent(ctx.userA, task.id, 'approve');
    const payload = await nextPayload(task);
    expect(payload.step.platform).toBe('android');
    expect(payload.context.bdd_plan).toContain('Revised BDD');
    expect(payload.context.plan).toBe('# Final plan');
    const project = await ctx.repo.getProject(ctx.userA, task.projectId!);
    await ctx.repo.updateProject(ctx.userA, project!.id, { platforms: ['web'] });
    expect((await orch().resolveWorkflow(ctx.userA, await reload(ctx, ctx.userA, task)))!.mobilePlatforms).toEqual(['android']);
  });
});
