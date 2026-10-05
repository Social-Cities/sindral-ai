import { expect, test } from '@playwright/test';
import { FULL_SDLC_WORKFLOW, snapshotWorkflow, type Job } from '../packages/shared/dist/index.js';
import { installMockBackend, makeArtifact, makeEvent, makePullRequest, makeTask, signIn } from './mockBackend';

test('signs in and creates tasks from text, an uploaded plan, and a ticket URL', async ({ page }) => {
  const backend = await installMockBackend(page);
  await signIn(page);
  await expect(page.getByTestId('worker-panel')).toContainText('No worker connected');

  await page.getByLabel('Task description').fill('Add audit logging\nCapture privileged changes.');
  await page.getByLabel('Repositories').fill('acme/api, acme/web');
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByText('Add audit logging', { exact: true })).toBeVisible();
  expect(backend.tasks[0]?.repos).toEqual(['acme/api', 'acme/web']);

  await page.goto('/');
  await page.getByLabel('Upload plan file').setInputFiles({ name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('# Upgrade plan\n\nDo the work safely.') });
  await expect(page.getByText('Loaded plan.md')).toBeVisible();
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText('# Upgrade plan', { exact: true })).toBeVisible();

  await page.goto('/');
  await page.getByRole('tab', { name: 'Paste a URL' }).click();
  await page.getByLabel('Ticket URL').fill('https://github.com/acme/api/issues/42');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByLabel('Imported title')).toHaveValue('Imported issue title');
  await expect(page.getByText('GitHub', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText('Imported issue title', { exact: true })).toBeVisible();
  expect(backend.tasks[2]?.ticketUrl).toBe('https://github.com/acme/api/issues/42');
});

test('pins the workflow and sends plan feedback into the revision loop', async ({ page }) => {
  const task = makeTask({
    state: 'plan-review',
    currentStepId: 'plan-review',
    plan: '# Approved direction\n\n1. Add the boundary.',
    pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
  });
  await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByText('Pinned — changes to this workflow')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByTestId('chat-hint')).toContainText('Sending will trigger an agent revision');
  await page.getByRole('textbox', { name: 'Message' }).fill('Please add a rollback step.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('Please add a rollback step.');
  await expect(page.getByText('Plan Feedback', { exact: true })).toBeVisible();
});

test('shows multiple repository diffs and auditable conflict escalation evidence', async ({ page }) => {
  const first = makePullRequest();
  const second = makePullRequest({
    id: 'pr-2',
    taskRepositoryId: 'repo-2',
    repository: 'acme/web',
    url: 'https://github.com/acme/web/pull/17',
    number: 17,
    branch: 'sindral/SIN-1-web',
    headSha: 'b'.repeat(40),
  });
  const evidence = makeArtifact({
    name: 'conflict-resolution-job-7.json',
    contentType: 'application/json',
    content: '{"outcome":"escalated","reason":"protected file","paths":[".github/workflows/ci.yml"]}',
    byteSize: 101,
  });
  const task = makeTask({
    state: 'failure',
    currentStepId: 'in-review',
    failedStepId: 'in-review',
    lastError: 'Automatic conflict resolution requires human review: protected file changed.',
    repos: ['acme/api', 'acme/web'],
    prUrl: first.url,
    pullRequests: [first, second],
    artifacts: [evidence],
    events: [makeEvent({ type: 'conflict-resolution-escalated', fromState: null, toState: null, stepId: null, detail: { reason: 'protected-file', jobId: 'job-7' } })],
    pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
  });
  const job: Job = {
    id: 'job-7', userId: task.userId, taskId: task.id, kind: 'resolve-rebase-conflict', stepId: null, status: 'failed', workerId: 'worker-1', attempt: 1,
    payload: {
      kind: 'resolve-rebase-conflict', repository: 'acme/web', taskId: task.id, taskKey: task.key, branch: second.branch, baseBranch: 'main',
      sourceSha: 'b'.repeat(40), targetSha: 'c'.repeat(40), conflictedPaths: ['.github/workflows/ci.yml'], engine: 'claude', model: 'claude-opus-5', mode: 'high',
      context: { task_key: task.key, task_title: task.title, task_description: task.description, task_outcome: task.outcome, acceptance_criteria: task.acceptanceCriteria, plan: 'Plan', feedback: '', pr_url: second.url, parent_plan: '', sibling_summaries: '', review_slices: '', review: '', verify_report: '', error: task.lastError ?? '' },
      policy: { allowedPaths: ['.github/workflows/ci.yml'], protectedPaths: ['.github/'], validationCommands: [['pnpm', 'test']], maxFiles: 10, maxChangedLines: 500 },
    },
    result: null, error: task.lastError, outcomeHash: null, outcomeToken: null, outcomeStartedAt: null, dedupeKey: null, createdAt: task.createdAt, claimedAt: task.createdAt, leaseExpiresAt: null, finishedAt: task.updatedAt,
  };
  await installMockBackend(page, {
    tasks: [task],
    jobs: { [task.id]: [job] },
    diffs: {
      'acme/api': [{ filename: 'src/api.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old api\n+new api' }],
      'acme/web': [{ filename: 'src/web.tsx', status: 'modified', additions: 4, deletions: 2, patch: '@@ -1 +1 @@\n-old web\n+new web' }],
    },
  });
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByText('Task failed')).toBeVisible();
  await expect(page.getByText(task.lastError!)).toBeVisible();
  await expect(page.getByText('acme/api', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('acme/web', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Code' }).click();
  await page.getByLabel('Repository').selectOption('acme/web');
  await expect(page.getByText('src/web.tsx')).toBeVisible();

  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await expect(page.getByText('conflict-resolution-job-7.json').first()).toBeVisible();
  await expect(page.getByText(/protected file/)).toBeVisible();

  await page.getByRole('tab', { name: 'Steps' }).click();
  await expect(page.getByText('Conflict resolution escalated')).toBeVisible();
  await expect(page.getByText('Resolve rebase conflict')).toBeVisible();
});

test('renders stored non-code artifacts and actionable failure recovery', async ({ page }) => {
  const stored = makeArtifact({ id: 'stored', name: 'research.md', content: null, byteSize: 82_000, downloadUrl: 'https://storage.example.test/research.md' });
  const task = makeTask({
    title: 'Produce research brief',
    state: 'failure',
    currentStepId: 'write',
    failedStepId: 'write',
    workflowId: 'wf-document',
    pinnedWorkflow: null,
    lastError: 'Writer process timed out after 10 minutes.',
    artifacts: [stored],
  });
  await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Troubleshoot' })).toBeVisible();
  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await expect(page.getByRole('link', { name: 'Download artifact' })).toHaveAttribute('href', stored.downloadUrl!);
});

test('announces active automatic conflict resolution accurately', async ({ page }) => {
  const task = makeTask({
    state: 'conflict-resolution',
    currentStepId: 'in-review',
    failedStepId: 'in-review',
    pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
  });
  await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByTestId('pipeline-offpath')).toContainText('Resolving Conflict');
  await expect(page.getByText('Agent is working')).toBeVisible();
});
