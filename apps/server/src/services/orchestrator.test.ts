import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TROUBLESHOOT_STEP, TransitionError, type AgentJobPayload, type Task } from '@sindral/shared';
import { claimNext, completeMerge, completeNext, createTestApp, plan, pr, reload, review, verdict, type TestContext } from '../test/helpers.js';
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
    expect(workflows).toHaveLength(4);
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

    await completeNext(ctx, userId, pr(7));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('adversarial-review');
    expect(task.prUrl).toBe('https://github.com/acme/app/pull/7');
    expect(agentPayload((await queuedJobs(task.id))[0]!).context.pr_url).toBe('https://github.com/acme/app/pull/7');

    await completeNext(ctx, userId, review());
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('verify');
    const artifacts = await ctx.repo.listArtifacts(userId, task.id);
    expect(artifacts.map((a) => a.name)).toEqual(['adversarial-review.md']);
    expect(agentPayload((await queuedJobs(task.id))[0]!).context.review).toBe('# Review');

    await completeNext(ctx, userId, verdict(true));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('in-review');
    expect((await ctx.repo.listArtifacts(userId, task.id)).map((a) => a.name)).toEqual(['adversarial-review.md', 'verify-report.md']);

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
      'implement->adversarial-review',
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
    await completeNext(ctx, userId, {
      kind: 'pr',
      summary: 'Opened both pull requests',
      prUrl: 'https://github.com/acme/app/pull/1',
      branch: task.branch!,
      pullRequests: [
        { repository: 'acme/app', prUrl: 'https://github.com/acme/app/pull/1', number: 1, branch: task.branch!, baseBranch: 'main', headSha: 'a'.repeat(40) },
        { repository: 'acme/api', prUrl: 'https://github.com/acme/api/pull/2', number: 2, branch: task.branch!, baseBranch: 'main', headSha: 'b'.repeat(40) },
      ],
    });
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
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
    await completeNext(ctx, userId, pr(9));

    await completeNext(ctx, userId, {
      kind: 'review',
      summary: 'reviewed',
      report: '# Review\n\n## Diff explanation\nChanged the task detail view.\n\n## Findings ordered by severity\nNo material findings.',
      verdict: 'NO_MATERIAL_FINDINGS',
    });

    const artifacts = await ctx.repo.listArtifacts(userId, task.id);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(['diff-explanation.md', 'adversarial-review.md']);
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
    await completeNext(ctx, userId, plan());
    const { message, task: after } = await orch().postUserMessage(userId, task.id, 'Please add tests', 'web');
    expect(message?.role).toBe('user');
    expect(after.state).toBe('planning-feedback');
    const job = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(job).step.id).toBe('planning-feedback');
    expect(agentPayload(job).context.feedback).toBe('Please add tests');
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
    await completeNext(ctx, userId, pr());
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(false, 'Fix the null check'));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('implement-feedback');
    const job = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(job).context.feedback).toBe('Fix the null check');
    expect(agentPayload(job).context.verify_report).toBe('# Verify');
    expect(agentPayload(job).prUrl).toBe('https://github.com/acme/app/pull/1');
    await completeNext(ctx, userId, pr());
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('adversarial-review');
  });

  it('in-review feedback dispatches address-feedback and returns to review after GO', async () => {
    let task = await newTask();
    await orch().applyUserEvent(userId, task.id, 'start');
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, task.id, 'approve');
    await completeNext(ctx, userId, pr());
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    const { task: after } = await orch().postUserMessage(userId, task.id, 'Rename the helper', 'web');
    expect(after.state).toBe('implement-feedback');
    await completeNext(ctx, userId, pr());
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('in-review');
  });
});

describe('task contracts outside planning workflows', () => {
  it('blocks a custom plan-review transition with a nonstandard event until the contract exists', async () => {
    const service = ctx.app.ctx.workflows;
    const custom = await service.create(userId, 'Custom review');
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
    const custom = await service.create(userId, 'Legacy review');
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

  it('does not persist a generated contract from an invalid first PR result', async () => {
    const fastTrack = (await ctx.app.ctx.workflows.list(userId)).find((workflow) => workflow.name === 'Fast Track')!;
    const task = await newTask({ workflowId: fastTrack.id });
    await orch().applyUserEvent(userId, task.id, 'start');
    const invalidPr = pr();
    if (invalidPr.kind !== 'pr') throw new Error('expected PR result');

    await expect(
      completeNext(ctx, userId, {
        ...invalidPr,
        outcome: 'Rejected outcome',
        acceptanceCriteria: '- Rejected criterion.',
        branch: 'wrong-branch',
      }),
    ).rejects.toThrow(/Legacy pull request fields do not match/);
    expect(await ctx.repo.getTask(userId, task.id)).toMatchObject({ outcome: '', acceptanceCriteria: '' });
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
});

describe('subtask stacks', () => {
  const SUBTASKS = [
    { title: 'Add schema', goal: 'Create the DB schema' },
    { title: 'Add API', goal: 'Expose the endpoints' },
    { title: 'Add UI', goal: 'Wire the screens' },
  ];

  async function plannedParent(): Promise<{ parent: Task; children: Task[] }> {
    const parent = await newTask({ title: 'Big feature' });
    await orch().applyUserEvent(userId, parent.id, 'start');
    await completeNext(ctx, userId, plan('# Parent plan', SUBTASKS));
    const children = await ctx.repo.listSubtasks(userId, parent.id);
    return { parent: await reload(ctx, userId, parent), children };
  }

  it('creates ordered children with chained base branches and the parent snapshot', async () => {
    const { parent, children } = await plannedParent();
    expect(parent.state).toBe('plan-review');
    expect(children.map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(children.map((c) => c.key)).toEqual(['SIN-2', 'SIN-3', 'SIN-4']);
    expect(children.map((c) => c.baseBranch)).toEqual([null, 'sindral/sin-2', 'sindral/sin-3']);
    expect(children.every((c) => c.parentTaskId === parent.id && c.state === 'todo')).toBe(true);
    expect(children[0]!.pinnedWorkflow?.name).toBe('Full SDLC');
    expect(children[0]!.description).toBe('Create the DB schema');
    expect(children[0]!.repos).toEqual(['acme/app']);
    const list = await ctx.repo.listTasks(userId, {});
    expect(list.map((t) => t.id)).toEqual([parent.id]);
  });

  it('does not create subtasks for a single subtask or for a subtask plan', async () => {
    const parent = await newTask();
    await orch().applyUserEvent(userId, parent.id, 'start');
    await completeNext(ctx, userId, plan('# p', [{ title: 'only', goal: 'one' }]));
    expect(await ctx.repo.listSubtasks(userId, parent.id)).toHaveLength(0);
  });

  it('keeps the first completed subtask stack when a plan is revised', async () => {
    const { parent, children } = await plannedParent();
    await orch().postUserMessage(userId, parent.id, 'Revise the plan without replacing the active stack', 'web');
    await completeNext(ctx, userId, plan('# Revised', [...SUBTASKS, { title: 'Unexpected extra', goal: 'Do not append this' }]));

    expect((await ctx.repo.listSubtasks(userId, parent.id)).map((child) => child.id)).toEqual(children.map((child) => child.id));
  });

  it('starts child #1 instead of dispatching the parent implement step, then runs children serially', async () => {
    const { parent, children } = await plannedParent();
    let p = await orch().applyUserEvent(userId, parent.id, 'approve');
    expect(p.state).toBe('implement');
    expect(await queuedJobs(parent.id)).toHaveLength(0);

    let c1 = await reload(ctx, userId, children[0]!);
    expect(c1.state).toBe('planning');
    const c1Job = (await queuedJobs(c1.id))[0]!;
    expect(agentPayload(c1Job).context.parent_plan).toBe('# Parent plan');
    expect(agentPayload(c1Job).context.sibling_summaries).toBe('');
    expect((await reload(ctx, userId, children[1]!)).state).toBe('todo');

    // child 1 through to in-review
    await completeNext(ctx, userId, plan('# c1 plan'));
    c1 = await reload(ctx, userId, c1);
    expect(c1.state).toBe('implement');
    expect((await ctx.repo.listEvents(userId, c1.id)).find((event) => event.detail?.['reason'] === 'parent-plan-approved')).toMatchObject({
      type: 'transition',
      detail: { event: 'approve', actor: 'system', reason: 'parent-plan-approved', parentTaskId: parent.id },
    });
    expect(agentPayload((await queuedJobs(c1.id))[0]!).step.id).toBe('implement');
    await completeNext(ctx, userId, pr(10, 'sindral/sin-2'));
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    c1 = await reload(ctx, userId, c1);
    expect(c1.state).toBe('in-review');

    // child 2 was started when child 1 hit in-review
    const c2 = await reload(ctx, userId, children[1]!);
    expect(c2.state).toBe('planning');
    const c2Job = (await queuedJobs(c2.id))[0]!;
    expect(agentPayload(c2Job).context.sibling_summaries).toContain('SIN-2 Add schema');
    expect(agentPayload(c2Job).context.sibling_summaries).toContain('GO');
    expect(agentPayload(c2Job).baseBranch).toBe('sindral/sin-2');
    expect((await reload(ctx, userId, children[2]!)).state).toBe('todo');

    p = await reload(ctx, userId, parent);
    expect(p.state).toBe('implement');
  });

  it('requires active children to close first and settles a declined stack as wont-do', async () => {
    const { parent, children } = await plannedParent();
    await orch().applyUserEvent(userId, parent.id, 'approve');

    await expect(orch().applyUserEvent(userId, parent.id, 'mark-wont-do')).rejects.toThrow(/Close active subtasks/);

    for (const child of children) {
      await orch().applyUserEvent(userId, child.id, 'mark-wont-do');
    }

    expect((await reload(ctx, userId, parent)).state).toBe('wont-do');
    expect((await ctx.repo.listSubtasks(userId, parent.id)).map((child) => child.state)).toEqual(['wont-do', 'wont-do', 'wont-do']);
    expect((await ctx.repo.listEvents(userId, parent.id)).at(-1)).toMatchObject({
      type: 'transition',
      toState: 'wont-do',
      detail: { event: 'mark-wont-do', actor: 'system', reason: 'subtasks-complete' },
    });
  });

  it('serializes child closure against active parent maintenance', async () => {
    const { parent, children } = await plannedParent();
    const maintenance = await ctx.repo.createJob(userId, {
      taskId: parent.id,
      kind: 'rebase-stack',
      stepId: null,
      payload: { kind: 'rebase-stack', repos: ['acme/app'], stack: [] },
    });
    const claim = (await ctx.repo.claimJobs(userId, 'maintenance-worker', 10)).find((job) => job.id === maintenance.id)!;
    await orch().applyUserEvent(userId, parent.id, 'approve');

    await expect(orch().applyUserEvent(userId, children[0]!.id, 'mark-wont-do')).rejects.toThrow(/active work/);

    await orch().completeJob(userId, claim.id, { kind: 'rebase', summary: 'maintenance complete', rebased: [] }, claim.attempt, claim.leaseToken);
    for (const child of children) await orch().applyUserEvent(userId, child.id, 'mark-wont-do');
    expect((await reload(ctx, userId, parent)).state).toBe('wont-do');
  });

  it('reconciles a terminal child stack when a finalized parent outcome is replayed', async () => {
    const { parent, children } = await plannedParent();
    await orch().applyUserEvent(userId, parent.id, 'approve');
    for (const child of children) await ctx.repo.updateTask(userId, child.id, { state: 'wont-do' });
    const maintenance = await ctx.repo.createJob(userId, {
      taskId: parent.id,
      kind: 'rebase-stack',
      stepId: null,
      payload: { kind: 'rebase-stack', repos: ['acme/app'], stack: [] },
    });
    const claim = (await ctx.repo.claimJobs(userId, 'replay-worker', 10)).find((job) => job.id === maintenance.id)!;
    const result = { kind: 'rebase' as const, summary: 'already applied', rebased: [] };
    const outcomeHash = createHash('sha256').update(JSON.stringify({ result })).digest('hex');
    const outcome = await ctx.repo.beginJobOutcome(userId, claim.id, claim.attempt, outcomeHash, { result }, claim.leaseToken);
    expect(outcome.state).toBe('acquired');
    await ctx.repo.finalizeJobOutcome(userId, claim.id, claim.attempt, outcomeHash, outcome.token!, 'completed');

    await orch().completeJob(userId, claim.id, result, claim.attempt, claim.leaseToken);

    expect((await reload(ctx, userId, parent)).state).toBe('wont-do');
  });

  it('ignores rebase failures for a sibling that is already wont-do', async () => {
    const { parent, children } = await plannedParent();
    const sibling = children[1]!;
    await orch().applyUserEvent(userId, sibling.id, 'mark-wont-do');
    const rebase = await ctx.repo.createJob(userId, {
      taskId: parent.id,
      kind: 'rebase-stack',
      stepId: null,
      payload: { kind: 'rebase-stack', repos: ['acme/app'], stack: [{ taskId: sibling.id, branch: sibling.branch!, baseBranch: sibling.baseBranch! }] },
    });
    const claim = (await ctx.repo.claimJobs(userId, 'rebase-worker', 10)).find((job) => job.id === rebase.id)!;

    await orch().completeJob(userId, claim.id, {
      kind: 'rebase',
      summary: 'stale failure',
      rebased: [{ taskId: sibling.id, branch: sibling.branch!, ok: false, error: 'ignore me' }],
    }, claim.attempt, claim.leaseToken);

    expect(await reload(ctx, userId, sibling)).toMatchObject({ state: 'wont-do', lastError: null });
    expect(await ctx.repo.listMessages(userId, sibling.id)).toEqual([]);
    expect((await ctx.repo.getJob(userId, rebase.id))?.status).toBe('completed');
  });

  it('prunes a closing child from queued parent rebase work', async () => {
    const { parent, children } = await plannedParent();
    const [closing, remaining] = children;
    const onlyClosing = await ctx.repo.createJob(userId, {
      taskId: parent.id,
      kind: 'rebase-stack',
      stepId: null,
      payload: { kind: 'rebase-stack', repos: ['acme/app'], stack: [{ taskId: closing!.id, branch: closing!.branch!, baseBranch: 'main' }] },
    });
    const mixed = await ctx.repo.createJob(userId, {
      taskId: parent.id,
      kind: 'rebase-stack',
      stepId: null,
      payload: {
        kind: 'rebase-stack',
        repos: ['acme/app'],
        stack: [
          { taskId: closing!.id, branch: closing!.branch!, baseBranch: 'main' },
          { taskId: remaining!.id, branch: remaining!.branch!, baseBranch: closing!.branch! },
        ],
      },
    });

    await orch().applyUserEvent(userId, closing!.id, 'mark-wont-do');

    expect((await ctx.repo.getJob(userId, onlyClosing.id))?.status).toBe('cancelled');
    expect((await ctx.repo.getJob(userId, mixed.id))?.payload).toMatchObject({ stack: [{ taskId: remaining!.id }] });
    const claimed = await ctx.repo.claimJobs(userId, 'rebase-worker', 10);
    expect(claimed.flatMap((job) => (job.payload.kind === 'rebase-stack' ? job.payload.stack.map((entry) => entry.taskId) : []))).not.toContain(closing!.id);
  });

  it('resumes parent settlement and sibling progression when a manual closure is replayed', async () => {
    const { parent, children } = await plannedParent();
    await orch().applyUserEvent(userId, parent.id, 'approve');
    const service = orch();
    const completion = vi.spyOn(
      service as unknown as { onTaskCompleted(userId: string, task: Task): Promise<void> },
      'onTaskCompleted',
    );

    const first = await reload(ctx, userId, children[0]!);
    completion.mockRejectedValueOnce(new Error('simulated process exit after transition commit'));
    await expect(service.applyUserEvent(userId, first.id, 'mark-wont-do', first.version, 'close-first')).rejects.toThrow(/simulated process exit/);
    expect((await reload(ctx, userId, children[1]!)).state).toBe('todo');
    completion.mockRestore();

    await service.applyUserEvent(userId, first.id, 'mark-wont-do', first.version, 'close-first');
    expect((await reload(ctx, userId, children[1]!)).state).toBe('planning');

    await service.applyUserEvent(userId, children[1]!.id, 'mark-wont-do');
    const last = await reload(ctx, userId, children[2]!);
    const finalCompletion = vi.spyOn(
      service as unknown as { onTaskCompleted(userId: string, task: Task): Promise<void> },
      'onTaskCompleted',
    );
    finalCompletion.mockRejectedValueOnce(new Error('simulated process exit before parent settlement'));
    await expect(service.applyUserEvent(userId, last.id, 'mark-done', last.version, 'close-last')).rejects.toThrow(/simulated process exit/);
    expect((await reload(ctx, userId, parent)).state).toBe('implement');
    finalCompletion.mockRestore();

    await service.applyUserEvent(userId, last.id, 'mark-done', last.version, 'close-last');
    expect((await reload(ctx, userId, parent)).state).toBe('wont-do');
  });

  it('enqueues a rebase-stack job when an earlier child pushes while later children have PRs', async () => {
    const { parent, children } = await plannedParent();
    await orch().applyUserEvent(userId, parent.id, 'approve');
    // c1 → in-review
    await completeNext(ctx, userId, plan());
    await completeNext(ctx, userId, pr(10, 'sindral/sin-2'));
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    // c2 → in-review (has PR now)
    await completeNext(ctx, userId, plan());
    await completeNext(ctx, userId, pr(11, 'sindral/sin-3'));
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    expect((await reload(ctx, userId, children[2]!)).state).toBe('planning');

    // feedback on c1 → new push → rebase c2 (c3 has no PR yet)
    await orch().postUserMessage(userId, children[0]!.id, 'tweak', 'web');
    expect((await reload(ctx, userId, children[0]!)).state).toBe('implement-feedback');
    const c1Job = (await ctx.repo.listJobsForTask(userId, children[0]!.id)).find((j) => j.status === 'queued')!;
    await ctx.repo.claimJobs(userId, 'w', 1); // c3 planning job is older; claim + ignore it so c1 is next
    const claimed = await ctx.repo.claimJobs(userId, 'w', 5);
    expect(claimed.map((j) => j.id)).toContain(c1Job.id);
    const c1Claim = claimed.find((job) => job.id === c1Job.id)!;
    await orch().completeJob(userId, c1Claim.id, pr(10, 'sindral/sin-2'), c1Claim.attempt, c1Claim.leaseToken);

    const parentJobs = await ctx.repo.listJobsForTask(userId, parent.id);
    const rebase = parentJobs.find((j) => j.kind === 'rebase-stack')!;
    expect(rebase).toBeDefined();
    expect(rebase.status).toBe('queued');
    expect(rebase.payload).toEqual({
      kind: 'rebase-stack',
      repos: ['acme/app'],
      stack: [{ taskId: children[1]!.id, branch: 'sindral/sin-3', baseBranch: 'sindral/sin-2' }],
    });

    // A plain failure still parks the sibling in failure.
    const rebaseClaim = (await ctx.repo.claimJobs(userId, 'w', 10)).find((job) => job.id === rebase.id)!;
    await expect(orch().completeJob(userId, rebaseClaim.id, pr(), rebaseClaim.attempt, rebaseClaim.leaseToken)).rejects.toMatchObject({ statusCode: 400 });
    await orch().completeJob(userId, rebaseClaim.id, {
      kind: 'rebase',
      summary: 'rebased',
      rebased: [{ taskId: children[1]!.id, branch: 'sindral/sin-3', ok: false, error: 'conflict in schema.sql' }],
    }, rebaseClaim.attempt, rebaseClaim.leaseToken);
    const c2 = await reload(ctx, userId, children[1]!);
    expect(c2.state).toBe('failure');
    expect(c2.lastError).toBe('conflict in schema.sql');
    expect(c2.failedStepId).toBe('in-review');
    expect((await reload(ctx, userId, parent)).state).toBe('implement');
  });

  it('defers restacking during automated review, then re-runs review after the rebase', async () => {
    const { parent, children } = await plannedParent();
    const [earlier, reviewing] = children;
    await ctx.repo.updateTask(userId, reviewing!.id, {
      prUrl: 'https://github.com/acme/app/pull/11',
      state: 'adversarial-review',
      currentStepId: 'adversarial-review',
    });
    const [taskRepository] = await ctx.repo.listTaskRepositories(userId, reviewing!.id);
    await ctx.repo.upsertPullRequest(userId, reviewing!.id, {
      taskRepositoryId: taskRepository!.id,
      repository: 'acme/app',
      url: 'https://github.com/acme/app/pull/11',
      number: 11,
      branch: reviewing!.branch!,
      baseBranch: earlier!.branch!,
      headSha: 'a'.repeat(40),
    });
    const service = orch() as unknown as {
      enqueueStackRebase(userId: string, child: Task, dedupePrefix: string): Promise<unknown>;
      resumeDeferredStackRebase(userId: string, task: Task): Promise<void>;
    };

    expect(await service.enqueueStackRebase(userId, earlier!, 'upstream-change')).toBeNull();
    const deferred = (await ctx.repo.listEvents(userId, reviewing!.id)).find((event) => event.type === 'stack-rebase-deferred');
    expect(deferred).toMatchObject({ detail: { triggerTaskId: earlier!.id } });
    expect((await ctx.repo.listJobsForTask(userId, parent.id)).filter((job) => job.kind === 'rebase-stack')).toHaveLength(0);

    const ready = (await ctx.repo.updateTask(userId, reviewing!.id, { state: 'in-review', currentStepId: 'in-review' }))!;
    await service.resumeDeferredStackRebase(userId, ready);
    const rebase = (await ctx.repo.listJobsForTask(userId, parent.id)).find((job) => job.kind === 'rebase-stack')!;
    expect(rebase.payload).toEqual({
      kind: 'rebase-stack',
      repos: ['acme/app'],
      stack: [{ taskId: reviewing!.id, branch: reviewing!.branch!, baseBranch: earlier!.branch! }],
    });

    const claim = (await ctx.repo.claimJobs(userId, 'restack-worker', 10)).find((job) => job.id === rebase.id)!;
    await orch().completeJob(userId, claim.id, {
      kind: 'rebase',
      summary: 'rebased onto the revised first subtask',
      rebased: [{ taskId: reviewing!.id, branch: reviewing!.branch!, ok: true, headSha: 'b'.repeat(40) }],
    }, claim.attempt, claim.leaseToken);

    expect(await reload(ctx, userId, reviewing!)).toMatchObject({ state: 'adversarial-review', currentStepId: 'adversarial-review' });
    expect(agentPayload((await queuedJobs(reviewing!.id))[0]!).step.id).toBe('adversarial-review');
    expect((await ctx.repo.listPullRequests(userId, reviewing!.id))[0]?.headSha).toBe('b'.repeat(40));
    expect((await ctx.repo.listEvents(userId, reviewing!.id)).some((event) => event.type === 'stack-rebase-resumed')).toBe(true);
  });

  it('lets implementation feedback take over from queued restacking without racing the branch', async () => {
    const { parent, children } = await plannedParent();
    const [earlier, reviewed] = children;
    await ctx.repo.updateTask(userId, reviewed!.id, {
      prUrl: 'https://github.com/acme/app/pull/11',
      state: 'in-review',
      currentStepId: 'in-review',
    });
    const service = orch() as unknown as {
      enqueueStackRebase(userId: string, child: Task, dedupePrefix: string): Promise<unknown>;
    };
    await service.enqueueStackRebase(userId, earlier!, 'queued-before-feedback');
    const rebase = (await ctx.repo.listJobsForTask(userId, parent.id)).find((job) => job.kind === 'rebase-stack')!;

    const response = await orch().postUserMessage(userId, reviewed!.id, 'Please revise the API shape', 'web');

    expect(response.task.state).toBe('implement-feedback');
    expect((await ctx.repo.getJob(userId, rebase.id))?.status).toBe('cancelled');
    expect((await ctx.repo.listEvents(userId, reviewed!.id)).some((event) => event.type === 'stack-rebase-cancelled-for-feedback')).toBe(true);
    expect(agentPayload((await queuedJobs(reviewed!.id))[0]!).step.id).toBe('implement-feedback');
  });

  it('blocks acceptance while a claimed restack is changing the reviewed branch', async () => {
    const { parent, children } = await plannedParent();
    const [earlier, reviewed] = children;
    const ready = (await ctx.repo.updateTask(userId, reviewed!.id, {
      prUrl: 'https://github.com/acme/app/pull/11',
      state: 'in-review',
      currentStepId: 'in-review',
    }))!;
    const service = orch() as unknown as {
      enqueueStackRebase(userId: string, child: Task, dedupePrefix: string): Promise<unknown>;
    };
    await service.enqueueStackRebase(userId, earlier!, 'claimed-before-accept');
    expect((await ctx.repo.claimJobs(userId, 'restack-worker', 1))[0]?.taskId).toBe(parent.id);

    await expect(orch().applyUserEvent(userId, ready.id, 'accept')).rejects.toThrow(/Stack maintenance/);
    expect((await reload(ctx, userId, ready)).state).toBe('in-review');
  });

  it('waits for every repository to restack before invalidating implementation review', async () => {
    const parent = await newTask({ repos: ['acme/app', 'acme/api'] });
    await orch().applyUserEvent(userId, parent.id, 'start');
    await completeNext(ctx, userId, plan('# Parent plan', SUBTASKS.slice(0, 2)));
    const [earlier, later] = await ctx.repo.listSubtasks(userId, parent.id);
    await ctx.repo.updateTask(userId, later!.id, {
      prUrl: 'https://github.com/acme/app/pull/11',
      state: 'in-review',
      currentStepId: 'in-review',
    });
    const service = orch() as unknown as {
      enqueueStackRebase(userId: string, child: Task, dedupePrefix: string): Promise<unknown>;
    };
    await service.enqueueStackRebase(userId, earlier!, 'multi-repo-change');
    const jobs = (await ctx.repo.listJobsForTask(userId, parent.id)).filter((job) => job.kind === 'rebase-stack');
    expect(jobs).toHaveLength(2);
    const claims = await ctx.repo.claimJobs(userId, 'restack-worker', 10);
    const result = {
      kind: 'rebase' as const,
      summary: 'rebased repository',
      rebased: [{ taskId: later!.id, branch: later!.branch!, ok: true }],
    };

    await orch().completeJob(userId, claims.find((claim) => claim.id === jobs[0]!.id)!.id, result, 1, claims.find((claim) => claim.id === jobs[0]!.id)!.leaseToken);
    expect((await reload(ctx, userId, later!)).state).toBe('in-review');
    const second = (await ctx.repo.claimJobs(userId, 'restack-worker', 10)).find((claim) => claim.id === jobs[1]!.id)!;
    await orch().completeJob(userId, second.id, result, second.attempt, second.leaseToken);
    expect((await reload(ctx, userId, later!)).state).toBe('adversarial-review');
  });

  it('queues a bounded resolver for a pinned rebase conflict and escalates an unsafe result', async () => {
    const { parent, children } = await plannedParent();
    const sibling = children[1]!;
    await ctx.repo.updateTask(userId, sibling.id, {
      prUrl: 'https://github.com/acme/app/pull/11',
      state: 'in-review',
      currentStepId: 'in-review',
      pinnedWorkflow: parent.pinnedWorkflow,
    });
    const rebase = await ctx.repo.createJob(userId, {
      taskId: parent.id,
      kind: 'rebase-stack',
      stepId: null,
      payload: {
        kind: 'rebase-stack',
        repos: ['acme/app'],
        stack: [{ taskId: sibling.id, branch: sibling.branch!, baseBranch: sibling.baseBranch! }],
      },
    });
    const rebaseClaim = (await ctx.repo.claimJobs(userId, 'w', 10)).find((job) => job.id === rebase.id)!;
    await orch().completeJob(userId, rebaseClaim.id, {
      kind: 'rebase',
      summary: 'conflict',
      rebased: [
        {
          taskId: sibling.id,
          branch: sibling.branch!,
          ok: false,
          error: 'conflict in src/schema.ts',
          conflict: {
            repository: 'acme/app',
            baseBranch: sibling.baseBranch!,
            sourceSha: 'a'.repeat(40),
            targetSha: 'b'.repeat(40),
            conflictedPaths: ['src/schema.ts'],
          },
        },
      ],
    }, rebaseClaim.attempt, rebaseClaim.leaseToken);

    const resolver = (await ctx.repo.listJobsForTask(userId, sibling.id)).find((job) => job.kind === 'resolve-rebase-conflict');
    expect(resolver?.payload).toMatchObject({
      kind: 'resolve-rebase-conflict',
      taskId: sibling.id,
      repository: 'acme/app',
      branch: sibling.branch,
      conflictedPaths: ['src/schema.ts'],
      policy: { allowedPaths: ['src/schema.ts'], maxFiles: 20, maxChangedLines: 1000 },
    });
    expect((await reload(ctx, userId, sibling)).state).toBe('conflict-resolution');

    const resolverClaim = (await ctx.repo.claimJobs(userId, 'w', 10)).find((job) => job.id === resolver!.id)!;
    await orch().completeJob(userId, resolverClaim.id, {
      kind: 'conflict-resolution',
      summary: 'Needs a human',
      taskId: sibling.id,
      branch: sibling.branch!,
      resolved: false,
      rationale: 'The two changes specify different schemas.',
      resolvedPaths: [],
      checks: [],
      error: 'Ambiguous intent',
    }, resolverClaim.attempt, resolverClaim.leaseToken);
    const failedSibling = await reload(ctx, userId, sibling);
    expect(failedSibling.state).toBe('failure');
    expect(failedSibling.lastError).toBe('Ambiguous intent');
    expect((await ctx.repo.listEvents(userId, sibling.id)).some((event) => event.type === 'conflict-resolution-escalated')).toBe(true);
    const evidence = (await ctx.repo.listArtifacts(userId, sibling.id)).find((artifact) => artifact.name.startsWith('conflict-resolution-'));
    expect(evidence).toBeDefined();
    expect(JSON.parse(evidence!.content!)).toMatchObject({ promptVersion: 'rebase-conflict-v1', outcome: 'escalated', error: 'Ambiguous intent' });
  });

  it('completes the parent when every child is done', async () => {
    const parent = await newTask();
    await orch().applyUserEvent(userId, parent.id, 'start');
    await completeNext(ctx, userId, plan('# p', SUBTASKS.slice(0, 2)));
    await orch().applyUserEvent(userId, parent.id, 'approve');
    const [c1, c2] = await ctx.repo.listSubtasks(userId, parent.id);
    for (const [index, child] of [c1!, c2!].entries()) {
      await completeNext(ctx, userId, plan());
      // Each subtask has its own branch; the worker must report the branch it was given.
      await completeNext(ctx, userId, pr(10 + index, child.branch!));
      await completeNext(ctx, userId, review());
      await completeNext(ctx, userId, verdict(true));
    }
    expect((await reload(ctx, userId, parent)).state).toBe('implement');
    await orch().applyUserEvent(userId, c1!.id, 'accept');
    await completeMerge(ctx, userId);
    expect((await reload(ctx, userId, parent)).state).toBe('implement');
    await orch().applyUserEvent(userId, c2!.id, 'accept');
    await completeMerge(ctx, userId);
    const done = await reload(ctx, userId, parent);
    expect(done.state).toBe('done');
    expect(done.currentStepId).toBe('done');
    const events = await ctx.repo.listEvents(userId, parent.id);
    expect(events.at(-1)).toMatchObject({ type: 'transition', toState: 'done', detail: { event: 'mark-done', actor: 'system', reason: 'subtasks-complete' } });
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
    expect(after).toHaveLength(3);
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
