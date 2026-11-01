import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TROUBLESHOOT_STEP, FULL_SDLC_WORKFLOW, TransitionError, type AgentJobPayload, type Task } from '@sindral/shared';
import { claimNext, completeMerge, completeNext, createTestApp, implementation, plan, pr, reload, review, reviewSlice, verdict, type TestContext } from '../test/helpers.js';
import { HttpError } from '../errors.js';

let ctx: TestContext;
let userId: string;

beforeEach(async () => {
  ctx = await createTestApp();
  userId = ctx.userA;
});
afterEach(async () => {
  await ctx.app.close();
});

const orch = () => ctx.app.ctx.orchestrator;

async function newTask(input: Partial<{ title: string; repos: string[]; key: string; workflowId: string; description: string }> = {}): Promise<Task> {
  return orch().createTask(userId, { title: input.title ?? 'Build feature', description: input.description ?? 'Do the thing', repos: input.repos ?? ['acme/app'], key: input.key, workflowId: input.workflowId });
}

async function queuedJobs(taskId: string) {
  return (await ctx.repo.listJobsForTask(userId, taskId)).filter((j) => j.status === 'queued');
}

function agentPayload(job: { payload: unknown }): AgentJobPayload {
  const payload = job.payload as AgentJobPayload;
  expect(payload.kind).toBe('agent');
  return payload;
}

describe('task creation', () => {
  it('assigns SIN-n keys, default workflow and branch', async () => {
    const t1 = await newTask();
    const t2 = await newTask({ repos: [] });
    expect(t1.key).toBe('SIN-1');
    expect(t2.key).toBe('SIN-2');
    expect(t1.branch).toBe('sindral/sin-1');
    expect(t2.branch).toBeNull();
    expect(t1.state).toBe('todo');
    expect(t1.pinnedWorkflow).toBeNull();
    const workflows = await ctx.app.ctx.workflows.list(userId);
    expect(workflows).toHaveLength(6);
    expect(t1.workflowId).toBe(workflows.find((w) => w.isDefault)!.id);
  });

  it('uses the ticket key when given and rejects duplicates', async () => {
    const t = await newTask({ key: 'ENG-42' });
    expect(t.key).toBe('ENG-42');
    expect(t.branch).toBe('sindral/eng-42');
    await expect(newTask({ key: 'ENG-42' })).rejects.toThrow(/already exists/);
  });

  it('rejects an unknown workflow', async () => {
    await expect(newTask({ workflowId: 'nope' })).rejects.toBeInstanceOf(HttpError);
  });

  it('imports a structured task contract from the source description', async () => {
    const task = await newTask({
      description: '## Outcome\nUsers can recover a failed run.\n\n## Acceptance criteria\n- Retrying resumes the run.\n- The retry is audited.\n\n## Notes\nKeep the API stable.',
    });
    expect(task.outcome).toBe('Users can recover a failed run.');
    expect(task.acceptanceCriteria).toBe('- Retrying resumes the run.\n- The retry is audited.');
  });
});

describe('atomic task commands', () => {
  it('replays a concurrent duplicate and fences a concurrent distinct command', async () => {
    const duplicateTask = await newTask();
    const duplicate = await Promise.all([
      orch().applyUserEvent(userId, duplicateTask.id, 'start', duplicateTask.version, 'concurrent-same-key'),
      orch().applyUserEvent(userId, duplicateTask.id, 'start', duplicateTask.version, 'concurrent-same-key'),
    ]);
    expect(duplicate[0]).toEqual(duplicate[1]);
    expect(await queuedJobs(duplicateTask.id)).toHaveLength(1);
    expect((await ctx.repo.listEvents(userId, duplicateTask.id)).filter((event) => event.type === 'transition')).toHaveLength(1);

    const racingTask = await newTask();
    const racing = await Promise.allSettled([
      orch().applyUserEvent(userId, racingTask.id, 'start', racingTask.version, 'concurrent-key-one'),
      orch().applyUserEvent(userId, racingTask.id, 'start', racingTask.version, 'concurrent-key-two'),
    ]);
    expect(racing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(racing.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await queuedJobs(racingTask.id)).toHaveLength(1);
  });

  it('serializes manual closure against claimed worker outcomes', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    expect(job).not.toBeNull();

    await expect(orch().applyUserEvent(userId, task.id, 'mark-wont-do')).rejects.toThrow(/active work/);
    await orch().completeJob(userId, job!.id, plan('# completed plan'), job!.attempt, job!.leaseToken);
    const planned = await reload(ctx, userId, task);
    expect(planned).toMatchObject({ state: 'plan-review', plan: '# completed plan' });

    await orch().applyUserEvent(userId, task.id, 'mark-wont-do');
    const closed = await reload(ctx, userId, task);
    expect(closed).toMatchObject({ state: 'wont-do', plan: '# completed plan' });
  });
});

describe('full SDLC happy path', () => {
  it('moves from todo to done through worker completions and pins the workflow on first start', async () => {
    let task = await newTask();
    task = await orch().applyUserEvent(userId, task.id, 'start');
    expect(task.state).toBe('planning');
    expect(task.currentStepId).toBe('planning');
    expect(task.pinnedWorkflow?.name).toBe('Full SDLC');

    const [job] = await queuedJobs(task.id);
    const payload = agentPayload(job!);
    expect(payload.step.id).toBe('planning');
    expect(payload.context.task_key).toBe('SIN-1');
    expect(payload.context.task_description).toBe('Do the thing');
    expect(payload.context.task_outcome).toBe('');
    expect(payload.context.acceptance_criteria).toBe('');
    expect(payload.step.prompt).toContain('If either field is empty, define it from the task source');
    expect(payload.branch).toBe('sindral/sin-1');

    await completeNext(ctx, userId, plan('# The plan'));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('plan-review');
    expect(task.plan).toBe('# The plan');
    expect(task.outcome).toBe('The requested behavior is delivered.');
    expect(task.acceptanceCriteria).toBe('- The requested behavior is verified.');
    const messages = await ctx.repo.listMessages(userId, task.id);
    expect(messages.at(-1)).toMatchObject({ role: 'agent', source: 'worker', content: 'planned' });

    task = await orch().applyUserEvent(userId, task.id, 'approve');
    expect(task.state).toBe('implement');
    const implJob = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(implJob).context.plan).toBe('# The plan');
    expect(agentPayload(implJob).context.task_outcome).toBe('The requested behavior is delivered.');
    expect(agentPayload(implJob).context.acceptance_criteria).toBe('- The requested behavior is verified.');
    expect(agentPayload(implJob).step.prompt).toContain('Treat this contract as the definition of done.');

    await completeNext(ctx, userId, implementation());
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('review-slice');
    expect(agentPayload((await queuedJobs(task.id))[0]!).step.id).toBe('review-slice');

    await completeNext(ctx, userId, reviewSlice(7));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('adversarial-review');
    expect(task.prUrl).toBe('https://github.com/acme/app/pull/7');
    expect(agentPayload((await queuedJobs(task.id))[0]!).context.pr_url).toBe('https://github.com/acme/app/pull/7');
    expect(agentPayload((await queuedJobs(task.id))[0]!).context.review_slices).toContain('Implement requested behavior');

    await completeNext(ctx, userId, review());
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('verify');
    const artifacts = await ctx.repo.listArtifacts(userId, task.id);
    expect(artifacts.map((a) => a.name)).toEqual(['review-slices.json', 'adversarial-review.md']);
    expect(agentPayload((await queuedJobs(task.id))[0]!).context.review).toBe('# Review');

    await completeNext(ctx, userId, verdict(true));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('in-review');
    expect((await ctx.repo.listArtifacts(userId, task.id)).map((a) => a.name)).toEqual(['review-slices.json', 'adversarial-review.md', 'verify-report.md']);

    task = await orch().applyUserEvent(userId, task.id, 'accept');
    expect(task.state).toBe('merge');
    await completeMerge(ctx, userId);
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('done');
    expect(task.currentStepId).toBe('done');

    const events = await ctx.repo.listEvents(userId, task.id);
    const transitions = events.filter((e) => e.type === 'transition').map((e) => `${e.fromState}->${e.toState}`);
    expect(transitions).toEqual([
      'todo->planning',
      'planning->plan-review',
      'plan-review->implement',
      'implement->review-slice',
      'review-slice->adversarial-review',
      'adversarial-review->verify',
      'verify->in-review',
      'in-review->merge',
      'merge->done',
    ]);
    expect(events.find((e) => e.type === 'transition')?.detail).toMatchObject({ event: 'start', actor: 'user' });
    await expect(orch().applyUserEvent(userId, task.id, 'accept')).rejects.toBeInstanceOf(TransitionError);
  });

  it('records a partial multi-repository merge and fails without claiming completion', async () => {
    let task = await newTask({ repos: ['acme/app', 'acme/api'] });
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, task.id, 'approve');
    await completeNext(ctx, userId, implementation());
    await completeNext(ctx, userId, {
      kind: 'review-slice',
      summary: 'Opened both pull requests',
      prUrl: 'https://github.com/acme/app/pull/1',
      branch: task.branch!,
      slices: [
        { repository: 'acme/app', commit: 'a'.repeat(40), title: 'App changes', summary: 'Updates the app.', files: ['app.ts'] },
        { repository: 'acme/api', commit: 'b'.repeat(40), title: 'API changes', summary: 'Updates the API.', files: ['api.ts'] },
      ],
      pullRequests: [
        { repository: 'acme/app', prUrl: 'https://github.com/acme/app/pull/1', number: 1, branch: task.branch!, baseBranch: 'main', headSha: 'a'.repeat(40) },
        { repository: 'acme/api', prUrl: 'https://github.com/acme/api/pull/2', number: 2, branch: task.branch!, baseBranch: 'main', headSha: 'b'.repeat(40) },
      ],
    });
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true, undefined, ['acme/app', 'acme/api']));
    task = await orch().applyUserEvent(userId, task.id, 'accept');
    expect(task.state).toBe('merge');

    const job = await claimNext(ctx, userId);
    expect(job?.payload.kind).toBe('merge-pull-requests');
    if (!job || job.payload.kind !== 'merge-pull-requests') throw new Error('expected merge job');
    await orch().completeJob(userId, job.id, {
      kind: 'merge',
      summary: 'One merge succeeded and one was blocked by branch protection.',
      complete: false,
      pullRequests: job.payload.pullRequests.map((pullRequest, index) =>
        index === 0
          ? { id: pullRequest.id, repository: pullRequest.repository, url: pullRequest.url, merged: true }
          : { id: pullRequest.id, repository: pullRequest.repository, url: pullRequest.url, merged: false, error: 'Branch protection rejected the merge' },
      ),
    }, job.attempt, job.leaseToken);

    const failed = await reload(ctx, userId, task);
    expect(failed.state).toBe('failure');
    expect(failed.lastError).toBe('Branch protection rejected the merge');
    expect((await ctx.repo.listPullRequests(userId, task.id)).map((pullRequest) => pullRequest.status)).toEqual(['merged', 'open']);
  });

  it('stores diff explanation separately from the adversarial review report', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, task.id, 'approve');
    await completeNext(ctx, userId, implementation());
    await completeNext(ctx, userId, reviewSlice(9));

    await completeNext(ctx, userId, {
      kind: 'review',
      summary: 'reviewed',
      report: '# Review\n\n## Diff explanation\nChanged the task detail view.\n\n## Findings ordered by severity\nNo material findings.',
      verdict: 'NO_MATERIAL_FINDINGS',
    });

    const artifacts = await ctx.repo.listArtifacts(userId, task.id);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(['review-slices.json', 'diff-explanation.md', 'adversarial-review.md']);
    expect(artifacts.find((artifact) => artifact.name === 'diff-explanation.md')?.content).toBe('Changed the task detail view.');
    expect(artifacts.find((artifact) => artifact.name === 'adversarial-review.md')?.content).toBe('# Review\n\n## Findings ordered by severity\nNo material findings.');
    task = await reload(ctx, userId, task);
    expect(agentPayload((await queuedJobs(task.id))[0]!).context.review).toBe('# Review\n\n## Findings ordered by severity\nNo material findings.');
  });

  it('keeps using the pinned snapshot after the live workflow changes', async () => {
    let task = await newTask();
    task = await orch().applyUserEvent(userId, task.id, 'start');
    const live = await ctx.app.ctx.workflows.get(userId, task.workflowId!);
    await ctx.app.ctx.workflows.update(userId, live!.id, { ...live!, name: 'Renamed', edges: live!.edges.filter((e) => e.event !== 'approve') });
    await completeNext(ctx, userId, plan());
    task = await orch().applyUserEvent(userId, task.id, 'approve');
    expect(task.state).toBe('implement');
  });
});

describe('feedback loops', () => {
  it('chat on plan-review dispatches the revision agent with the feedback in context', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const planningJob = await claimNext(ctx, userId);
    await orch().completeJob(userId, planningJob!.id, plan(), planningJob!.attempt, planningJob!.leaseToken, '00000000-0000-4000-8000-000000000001');
    const { message, task: after } = await orch().postUserMessage(userId, task.id, 'Please add tests', 'web');
    expect(message?.role).toBe('user');
    expect(after.state).toBe('planning-feedback');
    const job = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(job).step.id).toBe('planning-feedback');
    expect(agentPayload(job).context.feedback).toBe('Please add tests');
    expect(agentPayload(job).resumeSessionId).toBe('00000000-0000-4000-8000-000000000001');
    const messages = await ctx.repo.listMessages(userId, task.id);
    expect(messages.at(-1)).toMatchObject({ role: 'system', source: 'web', content: 'Got it — Revise Plan is working on your request.' });
    await completeNext(ctx, userId, {
      kind: 'plan',
      summary: 'revised',
      plan: '# v2',
      outcome: 'Users get the revised result.',
      acceptanceCriteria: '- The revised behavior is covered by tests.',
    });
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('plan-review');
    expect(task.plan).toBe('# v2');
    expect(task.outcome).toBe('Users get the revised result.');
    expect(task.acceptanceCriteria).toBe('- The revised behavior is covered by tests.');
  });

  it('accepts legacy plan results when the task contract is embedded in markdown', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, {
      kind: 'plan',
      summary: 'planned',
      plan: '## Outcome\nThe deployment is recoverable.\n\n## Acceptance criteria\n- A failed deployment can be retried.',
    });
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('plan-review');
    expect(task.outcome).toBe('The deployment is recoverable.');
    expect(task.acceptanceCriteria).toBe('- A failed deployment can be retried.');
  });

  it('does not pin an invalid legacy plan revision before reporting its failure', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await ctx.repo.updateTask(userId, task.id, { outcome: '', acceptanceCriteria: '' });
    await orch().postUserMessage(userId, task.id, 'Please revise the plan', 'web');
    const job = await claimNext(ctx, userId);

    await expect(
      orch().completeJob(userId, job!.id, { kind: 'plan', summary: 'revised', plan: '# Revised plan' }, job!.attempt, job!.leaseToken),
    ).rejects.toThrow(/Plan results must define a task outcome and acceptance criteria/);

    expect(await ctx.repo.getJob(userId, job!.id)).toMatchObject({ status: 'claimed', outcomeHash: null, result: null });
    await orch().failJob(userId, job!.id, 'Plan result omitted the task contract', job!.attempt, job!.leaseToken);
    expect(await ctx.repo.getJob(userId, job!.id)).toMatchObject({ status: 'failed', error: 'Plan result omitted the task contract' });
  });

  it('does not acknowledge a saved chat note when no worker starts', async () => {
    const task = await newTask();
    await orch().postUserMessage(userId, task.id, 'Remember this', 'web');
    const messages = await ctx.repo.listMessages(userId, task.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Remember this' });
  });

  it('keeps a dispatched command successful when its acknowledgement cannot be saved', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    const createMessage = ctx.repo.createMessage.bind(ctx.repo);
    vi.spyOn(ctx.repo, 'createMessage')
      .mockImplementationOnce((...args) => createMessage(...args))
      .mockRejectedValueOnce(new Error('ack write failed'));

    const result = await orch().postUserMessage(userId, task.id, 'Please add tests', 'web');

    expect(result.task.state).toBe('planning-feedback');
    expect((await queuedJobs(task.id))[0]).toBeDefined();
  });

  it('collects only user messages since the last agent message', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().postUserMessage(userId, task.id, 'first', 'web');
    await completeNext(ctx, userId, plan('# v2'));
    await orch().postUserMessage(userId, task.id, 'second', 'web');
    const job = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(job).context.feedback).toBe('second');
  });

  it('chat while an agent runs is stored without a transition', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const { task: after } = await orch().postUserMessage(userId, task.id, 'note', 'web');
    expect(after.state).toBe('planning');
    expect(await queuedJobs(task.id)).toHaveLength(1);
  });

  it('verify NO_GO routes to implement-feedback with the verdict feedback as context', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, task.id, 'approve');
    const implementationJob = await claimNext(ctx, userId);
    await orch().completeJob(userId, implementationJob!.id, implementation(), implementationJob!.attempt, implementationJob!.leaseToken, '00000000-0000-4000-8000-000000000002');
    await completeNext(ctx, userId, reviewSlice());
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(false, 'Fix the null check'));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('implement-feedback');
    const job = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(job).context.feedback).toBe('Fix the null check');
    expect(agentPayload(job).context.verify_report).toBe('# Verify');
    expect(agentPayload(job).prUrl).toBe('https://github.com/acme/app/pull/1');
    expect(agentPayload(job).resumeSessionId).toBe('00000000-0000-4000-8000-000000000002');
    await completeNext(ctx, userId, reviewSlice());
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('adversarial-review');
  });

  it('in-review feedback dispatches address-feedback and returns to review after GO', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, task.id, 'approve');
    await completeNext(ctx, userId, implementation());
    await completeNext(ctx, userId, reviewSlice());
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    const { task: after } = await orch().postUserMessage(userId, task.id, 'Rename the helper', 'web');
    expect(after.state).toBe('implement-feedback');
    await completeNext(ctx, userId, reviewSlice());
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('in-review');
  });
});

describe('task contracts outside planning workflows', () => {
  it('blocks a custom plan-review transition with a nonstandard event until the contract exists', async () => {
    const service = ctx.app.ctx.workflows;
    const custom = await service.create(userId, 'Custom review', FULL_SDLC_WORKFLOW.id);
    await service.update(userId, custom.id, {
      ...custom,
      edges: custom.edges.map((edge) => (edge.from === 'plan-review' && edge.event === 'approve' ? { ...edge, event: 'ship' } : edge)),
    });
    let task = await newTask({ workflowId: custom.id });
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await ctx.repo.updateTask(userId, task.id, { outcome: '', acceptanceCriteria: '' });
    task = await reload(ctx, userId, task);

    await expect(orch().applyUserEvent(userId, task.id, 'ship')).rejects.toThrow(/needs an outcome and acceptance criteria/);
  });

  it('repairs a legacy plan contract before a custom review transition', async () => {
    const service = ctx.app.ctx.workflows;
    const custom = await service.create(userId, 'Legacy review', FULL_SDLC_WORKFLOW.id);
    await service.update(userId, custom.id, {
      ...custom,
      edges: custom.edges.map((edge) => (edge.from === 'plan-review' && edge.event === 'approve' ? { ...edge, event: 'ship' } : edge)),
    });
    let task = await newTask({ workflowId: custom.id });
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await ctx.repo.updateTask(userId, task.id, {
      plan: '### Outcome\nLegacy users can proceed.\n\n### Acceptance criteria\n- The existing plan can be approved.\n\n### Steps\n1. Ship.',
      outcome: '',
      acceptanceCriteria: '',
    });
    task = await reload(ctx, userId, task);

    task = await orch().applyUserEvent(userId, task.id, 'ship');
    expect(task.state).toBe('implement');
    expect(task.outcome).toBe('Legacy users can proceed.');
    expect(task.acceptanceCriteria).toBe('- The existing plan can be approved.');
  });

  it('persists a contract generated by the first document agent before review', async () => {
    const documentWorkflow = (await ctx.app.ctx.workflows.list(userId)).find((workflow) => workflow.name === 'Document (non-code)')!;
    let task = await newTask({ repos: [], workflowId: documentWorkflow.id });
    task = await orch().applyUserEvent(userId, task.id, 'start');
    const job = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(job).context.task_outcome).toBe('');
    expect(agentPayload(job).step.prompt).toContain('If either field is empty, define it from the task source');

    await completeNext(ctx, userId, {
      kind: 'document',
      summary: 'Wrote the guide',
      outcome: 'Readers can deploy the service safely.',
      acceptanceCriteria: '- The guide covers setup and rollback.',
      artifacts: [{ name: 'guide.md', contentType: 'text/markdown', content: '# Guide' }],
    });

    task = await reload(ctx, userId, task);
    expect(task).toMatchObject({
      state: 'in-review',
      outcome: 'Readers can deploy the service safely.',
      acceptanceCriteria: '- The guide covers setup and rollback.',
    });
  });

  it('rejects a first non-planning result that omits the generated contract', async () => {
    const documentWorkflow = (await ctx.app.ctx.workflows.list(userId)).find((workflow) => workflow.name === 'Document (non-code)')!;
    const task = await newTask({ repos: [], workflowId: documentWorkflow.id });
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    await expect(
      orch().completeJob(
        userId,
        job!.id,
        {
          kind: 'document',
          summary: 'Wrote the guide',
          artifacts: [{ name: 'guide.md', contentType: 'text/markdown', content: '# Guide' }],
        },
        job!.attempt,
        job!.leaseToken,
      ),
    ).rejects.toThrow(/must define its outcome and acceptance criteria/);

    // A semantic 400 must not pin the invalid result hash. The worker can then
    // report that rejection as the job failure instead of falling into 409s
    // until the lease sweeper misclassifies it as an unresponsive worker.
    expect(await ctx.repo.getJob(userId, job!.id)).toMatchObject({ status: 'claimed', outcomeHash: null, result: null });
    await orch().failJob(userId, job!.id, 'Result omitted the task contract', job!.attempt, job!.leaseToken);
    expect(await ctx.repo.getJob(userId, job!.id)).toMatchObject({ status: 'failed', error: 'Result omitted the task contract' });
  });

  it('does not persist a generated contract from an invalid first review-slice result', async () => {
    const fastTrack = (await ctx.app.ctx.workflows.list(userId)).find((workflow) => workflow.name === 'Fast Track')!;
    const task = await newTask({ workflowId: fastTrack.id });
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, implementation());
    const invalidReviewSlice = reviewSlice();
    if (invalidReviewSlice.kind !== 'review-slice') throw new Error('expected review-slice result');

    await expect(
      completeNext(ctx, userId, {
        ...invalidReviewSlice,
        outcome: 'Rejected outcome',
        acceptanceCriteria: '- Rejected criterion.',
        branch: 'wrong-branch',
      }),
    ).rejects.toThrow(/Legacy pull request fields do not match/);
    expect(await ctx.repo.getTask(userId, task.id)).toMatchObject({
      outcome: 'The requested behavior is delivered.',
      acceptanceCriteria: '- The requested behavior is verified.',
    });
  });
});

describe('failure handling', () => {
  it('notifies when an agent completion reaches a human step', async () => {
    await ctx.app.close();
    const notifications: { userId: string; kind: string; task: Task; stepLabel: string | null; error: string | null }[] = [];
    ctx = await createTestApp({
      notifications: {
        async notifyTaskStatus(nextUserId, notification) {
          notifications.push({ userId: nextUserId, ...notification });
        },
      },
    });
    userId = ctx.userA;

    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());

    expect(notifications).toMatchObject([
      { userId, kind: 'needs-input', stepLabel: 'Plan Review', task: { id: task.id, state: 'plan-review' }, error: null },
    ]);
  });

  it('notifies when a worker failure parks the task', async () => {
    await ctx.app.close();
    const notifications: { userId: string; kind: string; task: Task; stepLabel: string | null; error: string | null }[] = [];
    ctx = await createTestApp({
      notifications: {
        async notifyTaskStatus(nextUserId, notification) {
          notifications.push({ userId: nextUserId, ...notification });
        },
      },
    });
    userId = ctx.userA;

    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    await orch().failJob(userId, job!.id, 'npm install exploded', job!.attempt, job!.leaseToken);

    expect(notifications).toMatchObject([
      { userId, kind: 'failure', stepLabel: 'Planning Agent', task: { id: task.id, state: 'failure' }, error: 'npm install exploded' },
    ]);
  });

  async function failedTask(): Promise<Task> {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, task.id, 'approve');
    const job = await claimNext(ctx, userId);
    await orch().failJob(userId, job!.id, 'npm install exploded', job!.attempt, job!.leaseToken);
    return reload(ctx, userId, task);
  }

  it('parks the task in failure with the error and failed step', async () => {
    const task = await failedTask();
    expect(task.state).toBe('failure');
    expect(task.failedStepId).toBe('implement');
    expect(task.currentStepId).toBe('implement');
    expect(task.lastError).toBe('npm install exploded');
    const messages = await ctx.repo.listMessages(userId, task.id);
    expect(messages.at(-1)?.content).toContain('npm install exploded');
    const jobs = await ctx.repo.listJobsForTask(userId, task.id);
    expect(jobs.at(-1)?.status).toBe('failed');
  });

  it('troubleshoot → resolved → retries the failed step', async () => {
    let task = await failedTask();
    await orch().postUserMessage(userId, task.id, 'The registry needs a proxy', 'web');
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('failure');

    task = await orch().applyUserEvent(userId, task.id, 'troubleshoot');
    expect(task.state).toBe('troubleshoot');
    const job = (await queuedJobs(task.id))[0]!;
    const payload = agentPayload(job);
    expect(payload.step.id).toBe(DEFAULT_TROUBLESHOOT_STEP.id);
    expect(payload.context.error).toBe('npm install exploded');
    expect(payload.context.feedback).toContain('registry needs a proxy');

    await completeNext(ctx, userId, { kind: 'troubleshoot', summary: 'fixed', diagnosis: 'Set proxy', resolved: true });
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('implement');
    expect(task.failedStepId).toBeNull();
    expect(agentPayload((await queuedJobs(task.id))[0]!).step.id).toBe('implement');
  });

  it('troubleshoot unresolved returns to failure', async () => {
    let task = await failedTask();
    await orch().applyUserEvent(userId, task.id, 'troubleshoot');
    await completeNext(ctx, userId, { kind: 'troubleshoot', summary: 'stuck', diagnosis: 'Needs credentials', resolved: false });
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('failure');
    expect(task.failedStepId).toBe('implement');
  });

  it('retry re-dispatches the failed step directly', async () => {
    let task = await failedTask();
    task = await orch().applyUserEvent(userId, task.id, 'retry');
    expect(task.state).toBe('implement');
    expect(await queuedJobs(task.id)).toHaveLength(1);
    await expect(orch().applyUserEvent(userId, task.id, 'approve')).rejects.toBeInstanceOf(TransitionError);
  });

  it('can repin a failed task to the latest workflow before retrying', async () => {
    let task = await failedTask();
    const live = await ctx.app.ctx.workflows.get(userId, task.workflowId!);
    await ctx.app.ctx.workflows.update(userId, live!.id, {
      ...live!,
      steps: live!.steps.map((step) => (step.id === 'implement' ? { ...step, engine: 'codex', model: 'gpt-6.1-sol' } : step)),
    });

    const previousVersion = task.version;
    task = await orch().repinWorkflow(userId, task.id, previousVersion, 'repin-latest-workflow');
    expect(task.version).toBe(previousVersion + 1);
    expect(task.pinnedWorkflow?.steps.find((step) => step.id === 'implement')).toMatchObject({ engine: 'codex', model: 'gpt-6.1-sol' });
    expect((await ctx.repo.listEvents(userId, task.id)).at(-1)?.type).toBe('workflow-repinned');

    task = await orch().applyUserEvent(userId, task.id, 'retry');
    expect(task.state).toBe('implement');
    expect(agentPayload((await queuedJobs(task.id))[0]!).step).toMatchObject({ id: 'implement', engine: 'codex', model: 'gpt-6.1-sol' });
  });

  it('rejects results whose kind does not match the step output', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    await expect(orch().completeJob(userId, job!.id, pr(), job!.attempt, job!.leaseToken)).rejects.toMatchObject({ statusCode: 400 });
    await expect(orch().completeJob(userId, job!.id, plan(), job!.attempt, job!.leaseToken)).resolves.toBeUndefined();
    await expect(orch().completeJob(userId, job!.id, plan('# Different result'), job!.attempt, job!.leaseToken)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('treats an identical retried worker completion as idempotent', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    const result = plan('# Once');
    await orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken);
    const eventCount = (await ctx.repo.listEvents(userId, task.id)).length;
    const messageCount = (await ctx.repo.listMessages(userId, task.id)).length;
    await orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken);
    expect((await ctx.repo.listEvents(userId, task.id)).length).toBe(eventCount);
    expect((await ctx.repo.listMessages(userId, task.id)).length).toBe(messageCount);
  });

  it('rejects an expired or superseded lease and accepts only the reclaimed capability', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const worker = await ctx.repo.createWorker(userId, { name: 'lease-worker', hostname: 'h', version: '1', workerKeyId: null });
    const [first] = await ctx.repo.claimJobs(userId, worker.id, 1);
    await ctx.repo.updateJob(userId, first!.id, { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });

    await expect(orch().completeJob(userId, first!.id, plan(), first!.attempt, first!.leaseToken)).rejects.toMatchObject({ statusCode: 409 });
    expect((await reload(ctx, userId, task)).state).toBe('planning');
    expect(await orch().sweepStaleJobs()).toEqual({ requeued: 1, failed: 0 });

    const [second] = await ctx.repo.claimJobs(userId, worker.id, 1);
    expect(second!.attempt).toBe(2);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    await expect(orch().completeJob(userId, second!.id, plan(), second!.attempt, first!.leaseToken)).rejects.toMatchObject({ statusCode: 409 });
    await expect(orch().completeJob(userId, second!.id, plan(), second!.attempt, second!.leaseToken)).resolves.toBeUndefined();
    expect((await reload(ctx, userId, task)).state).toBe('plan-review');
  });

  it('fences concurrent completion processing and safely resumes an abandoned outcome', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    const result = plan('# durable');
    const concurrent = await Promise.allSettled([
      orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken),
      orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken),
    ]);
    expect(concurrent.some((entry) => entry.status === 'fulfilled')).toBe(true);
    await expect(orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken)).resolves.toBeUndefined();
    expect((await ctx.repo.listMessages(userId, task.id)).filter((message) => message.externalId === `job:${job!.id}:summary`)).toHaveLength(1);
    expect((await ctx.repo.listEvents(userId, task.id)).filter((event) => event.type === 'transition')).toHaveLength(2);

    task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const abandoned = await claimNext(ctx, userId);
    const outcomeHash = createHash('sha256').update(JSON.stringify({ result })).digest('hex');
    const claim = await ctx.repo.beginJobOutcome(userId, abandoned!.id, abandoned!.attempt, outcomeHash, { result }, abandoned!.leaseToken);
    expect(claim.state).toBe('acquired');
    await ctx.repo.abandonJobOutcome(userId, abandoned!.id, abandoned!.attempt, outcomeHash, claim.token!);
    await expect(orch().completeJob(userId, abandoned!.id, result, abandoned!.attempt, abandoned!.leaseToken)).resolves.toBeUndefined();
    expect((await ctx.repo.getJob(userId, abandoned!.id))?.status).toBe('completed');
    await expect(ctx.repo.beginJobOutcome(ctx.userB, abandoned!.id, abandoned!.attempt, outcomeHash, { result }, abandoned!.leaseToken)).rejects.toThrow(/owned/);
  });

  it('resumes after task effects commit but outcome finalization fails', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    const result = plan('# committed once');
    vi.spyOn(ctx.repo, 'finalizeJobOutcome').mockRejectedValueOnce(new Error('transient database failure'));

    await expect(orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken)).rejects.toThrow('transient database failure');
    expect((await reload(ctx, userId, task)).state).toBe('plan-review');
    await expect(orch().completeJob(userId, job!.id, result, job!.attempt, job!.leaseToken)).resolves.toBeUndefined();

    const events = await ctx.repo.listEvents(userId, task.id);
    expect(events.filter((event) => event.type === 'transition')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'stale-result')).toHaveLength(0);
    expect((await ctx.repo.listMessages(userId, task.id)).filter((message) => message.externalId === `job:${job!.id}:summary`)).toHaveLength(1);
  });

  it('stores a stale result without transitioning when the task has moved on', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    task = await orch().applyUserEvent(userId, task.id, 'fail');
    expect(task.state).toBe('failure');
    await orch().completeJob(userId, job!.id, plan('# late'), job!.attempt, job!.leaseToken);
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('failure');
    expect(task.plan).toBe('# late');
    expect((await ctx.repo.listEvents(userId, task.id)).some((e) => e.type === 'stale-result')).toBe(true);
  });

  it('deleting a task cancels queued jobs', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const [job] = await queuedJobs(task.id);
    await orch().deleteTask(userId, task.id);
    expect(await ctx.repo.getTask(userId, task.id)).toBeNull();
    expect(await ctx.repo.getJob(userId, job!.id)).toBeNull();
    expect(await claimNext(ctx, userId)).toBeNull();
  });

  it('stops a running agent step by requesting cancellation and moving to failure', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const [job] = await ctx.repo.claimJobs(userId, 'worker-1', 1);

    const stopped = await orch().stopRunningAgentStep(userId, task.id);

    expect(stopped).toMatchObject({ state: 'failure', failedStepId: 'planning', lastError: 'Planning Agent was stopped by the user.' });
    expect(await ctx.repo.jobCancellationRequests(userId, 'worker-1', [{ jobId: job!.id, leaseToken: job!.leaseToken }])).toEqual([job!.id]);
    expect((await ctx.repo.listMessages(userId, task.id)).at(-1)?.content).toMatch(/Planning Agent was stopped/);
  });

  it('restarts the active agent step when chat feedback arrives', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const [first] = await ctx.repo.claimJobs(userId, 'worker-1', 1);

    const { task: restarted } = await orch().postUserMessage(userId, task.id, 'Use the smaller API surface.', 'web');

    expect(restarted).toMatchObject({ state: 'planning', currentStepId: 'planning' });
    expect(await ctx.repo.jobCancellationRequests(userId, 'worker-1', [{ jobId: first!.id, leaseToken: first!.leaseToken }])).toEqual([first!.id]);
    expect(await ctx.repo.claimJobs(userId, 'worker-2', 1)).toEqual([]);

    await ctx.repo.acknowledgeJobCancellation(userId, first!.id, first!.attempt, first!.leaseToken);
    const [replacement] = await ctx.repo.claimJobs(userId, 'worker-2', 1);
    expect(replacement).toBeTruthy();
    expect(replacement!.id).not.toBe(first!.id);
    expect(agentPayload(replacement!).context.feedback).toBe('Use the smaller API surface.');
    expect((await ctx.repo.listEvents(userId, task.id)).some((event) => event.type === 'agent-restarted')).toBe(true);
  });
});


describe('job claiming', () => {
  it('serialises jobs per task and hands out the oldest first', async () => {
    const a = await newTask();
    const b = await newTask();
    await orch().applyUserEvent(userId, a.id, 'start');
    await orch().applyUserEvent(userId, b.id, 'start');
    await ctx.repo.createJob(userId, { taskId: a.id, kind: 'agent', stepId: 'x', payload: { kind: 'agent', step: DEFAULT_TROUBLESHOOT_STEP, context: {} as never, repos: [], branch: null, baseBranch: null, prUrl: null } });

    const first = await ctx.repo.claimJobs(userId, 'w1', 10);
    expect(first.map((j) => j.taskId)).toEqual([a.id, b.id]);
    expect(first.every((j) => j.status === 'claimed' && j.workerId === 'w1' && j.claimedAt)).toBe(true);
    expect(await ctx.repo.claimJobs(userId, 'w2', 10)).toEqual([]);

    await ctx.repo.updateJob(userId, first[0]!.id, { status: 'completed' });
    const next = await ctx.repo.claimJobs(userId, 'w2', 10);
    expect(next).toHaveLength(1);
    expect(next[0]!.taskId).toBe(a.id);
    expect(await ctx.repo.claimJobs(ctx.userB, 'w3', 10)).toEqual([]);
  });
});

describe('stale job sweeper', () => {
  it.each(['renewed', 'completed'] as const)('does not overwrite a job %s after the recovery snapshot', async (change) => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const job = await claimNext(ctx, userId);
    const expired = new Date(Date.now() - 10_000).toISOString();
    await ctx.repo.updateJob(userId, job!.id, { leaseExpiresAt: expired });
    const list = ctx.repo.listActiveJobs.bind(ctx.repo);
    vi.spyOn(ctx.repo, 'listActiveJobs').mockImplementationOnce(async () => {
      const snapshot = await list();
      await ctx.repo.updateJob(userId, job!.id, change === 'renewed'
        ? { leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() }
        : { status: 'completed' });
      return snapshot;
    });
    expect(await orch().sweepStaleJobs()).toEqual({ requeued: 0, failed: 0 });
    expect(await ctx.repo.getJob(userId, job!.id)).toMatchObject({ status: change === 'renewed' ? 'claimed' : 'completed', attempt: 1 });
  });

  it('resumes an abandoned durable outcome instead of rerunning the worker job', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const worker = await ctx.repo.createWorker(userId, { name: 'w', hostname: 'h', version: '1', workerKeyId: null });
    const [job] = await ctx.repo.claimJobs(userId, worker.id, 1);
    const result = {
      kind: 'plan' as const,
      summary: 'Recovered plan',
      plan: 'Durable plan',
      outcome: 'The recovered plan can proceed.',
      acceptanceCriteria: '- The durable result is applied once.',
    };
    const hash = createHash('sha256').update(JSON.stringify({ result })).digest('hex');
    const claim = await ctx.repo.beginJobOutcome(userId, job!.id, job!.attempt, hash, { result }, job!.leaseToken);

    expect(claim.state).toBe('acquired');
    expect(await orch().sweepStaleJobs(new Date(Date.now() + 31_000))).toEqual({ requeued: 0, failed: 0 });
    expect(await ctx.repo.getJob(userId, job!.id)).toMatchObject({ status: 'completed', result });
    expect((await reload(ctx, userId, task)).state).toBe('plan-review');
    expect((await ctx.repo.listMessages(userId, task.id)).filter((message) => message.content === result.summary)).toHaveLength(1);
  });

  it('requeues expired leases and fails them after the last attempt', async () => {
    const task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    const worker = await ctx.repo.createWorker(userId, { name: 'w', hostname: 'h', version: '1', workerKeyId: null });
    const [job] = await ctx.repo.claimJobs(userId, worker.id, 1);
    const old = new Date(Date.now() - 20 * 60_000).toISOString();

    // An unexpired renewable lease is untouched.
    expect(await orch().sweepStaleJobs()).toEqual({ requeued: 0, failed: 0 });

    await ctx.repo.updateJob(userId, job!.id, { leaseExpiresAt: old });
    expect(await orch().sweepStaleJobs()).toEqual({ requeued: 1, failed: 0 });
    let fresh = await ctx.repo.getJob(userId, job!.id);
    expect(fresh).toMatchObject({ status: 'queued', attempt: 2, workerId: null, claimedAt: null, leaseExpiresAt: null });

    await ctx.repo.claimJobs(userId, worker.id, 1);
    await ctx.repo.updateJob(userId, job!.id, { leaseExpiresAt: old, attempt: 3 });
    expect(await orch().sweepStaleJobs()).toEqual({ requeued: 0, failed: 1 });
    fresh = await ctx.repo.getJob(userId, job!.id);
    expect(fresh?.status).toBe('failed');
    const t = await reload(ctx, userId, task);
    expect(t.state).toBe('failure');
    expect(t.lastError).toMatch(/stopped responding/);
  });
});

describe('workflows service', () => {
  it('refuses to delete the last workflow and promotes a new default', async () => {
    const svc = ctx.app.ctx.workflows;
    const all = await svc.list(userId);
    const def = all.find((w) => w.isDefault)!;
    await svc.remove(userId, def.id);
    const after = await svc.list(userId);
    expect(after).toHaveLength(5);
    expect(after.filter((w) => w.isDefault)).toHaveLength(1);
    for (const w of after.slice(1)) await svc.remove(userId, w.id);
    await expect(svc.remove(userId, after[0]!.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('clones bundled or own workflows', async () => {
    const svc = ctx.app.ctx.workflows;
    const created = await svc.create(userId, 'Mine', 'wf-fast-track');
    expect(created.name).toBe('Mine');
    expect(created.steps.map((s) => s.id)).toContain('verify');
    expect(created.id).not.toBe('wf-fast-track');
    const again = await svc.create(userId, 'Copy', created.id);
    expect(again.steps).toEqual(created.steps);
    await expect(svc.create(userId, 'x', 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
