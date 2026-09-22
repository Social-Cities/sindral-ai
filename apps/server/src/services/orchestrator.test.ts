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
    expect(payload.branch).toBe('sindral/sin-1');

    await completeNext(ctx, userId, plan('# The plan'));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('plan-review');
    expect(task.plan).toBe('# The plan');
    const messages = await ctx.repo.listMessages(userId, task.id);
    expect(messages.at(-1)).toMatchObject({ role: 'agent', source: 'worker', content: 'planned' });

    task = await orch().applyUserEvent(userId, task.id, 'approve');
    expect(task.state).toBe('implement');
    const implJob = (await queuedJobs(task.id))[0]!;
    expect(agentPayload(implJob).context.plan).toBe('# The plan');

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
    await completeNext(ctx, userId, plan('# v2'));
    task = await reload(ctx, userId, task);
    expect(task.state).toBe('plan-review');
    expect(task.plan).toBe('# v2');
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

describe('failure handling', () => {
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
    await orch().applyUserEvent(userId, c1.id, 'approve');
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

  it('enqueues a rebase-stack job when an earlier child pushes while later children have PRs', async () => {
    const { parent, children } = await plannedParent();
    await orch().applyUserEvent(userId, parent.id, 'approve');
    // c1 → in-review
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, children[0]!.id, 'approve');
    await completeNext(ctx, userId, pr(10, 'sindral/sin-2'));
    await completeNext(ctx, userId, review());
    await completeNext(ctx, userId, verdict(true));
    // c2 → in-review (has PR now)
    await completeNext(ctx, userId, plan());
    await orch().applyUserEvent(userId, children[1]!.id, 'approve');
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
      await orch().applyUserEvent(userId, child.id, 'approve');
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
    expect(events.at(-1)).toMatchObject({ type: 'subtasks-complete', toState: 'done' });
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
    const result = { kind: 'plan' as const, summary: 'Recovered plan', plan: 'Durable plan' };
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
