import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { FULL_SDLC_WORKFLOW } from '../packages/shared/dist/index.js';
import { createTestApp } from '../apps/server/src/test/helpers.js';
import { installMockBackend, signIn } from './mockBackend';

test('moves a started ticket to a human checkpoint and runs a selected agent after prerequisite acknowledgement', async ({ page }) => {
  const ctx = await createTestApp();
  try {
    const orch = ctx.app.ctx.orchestrator;
    const task = await orch.createTask(ctx.userA, { title: 'Reassign this ticket', description: 'Implement the requested behavior', repos: ['acme/app'] });
    const destination = await ctx.app.ctx.workflows.create(ctx.userA, 'Destination process', FULL_SDLC_WORKFLOW.id);
    await orch.applyUserEvent(ctx.userA, task.id, 'start');
    await installMockBackend(page, { tasks: [await orch.getTaskWithRelations(ctx.userA, task.id)] });
    // Exercise real route validation, domain rules, job dispatch and persistence behind the browser UI.
    await page.route(/\/api\/(tasks|workflows)(\/|\?|$)/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const payload = request.postData();
      const key = request.headers()['idempotency-key'];
      const response = await ctx.app.inject({
        method: request.method() as 'GET' | 'POST', url: url.pathname + url.search,
        headers: { authorization: `Bearer ${ctx.tokenA}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
        ...(payload ? { payload } : {}),
      });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await signIn(page);
    await page.goto(`/tasks/${task.id}`);
    await page.getByRole('button', { name: 'Change workflow' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change workflow' });
    await dialog.getByLabel('Destination workflow').selectOption(destination.id);
    await expect(dialog.getByLabel('Destination step')).toHaveValue('todo');
    await dialog.getByLabel('Destination step').selectOption('plan-review');
    await expect(dialog.getByText('The task will wait at this step until you take an action.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Move to step' })).toBeEnabled();
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([]);
    await dialog.getByRole('button', { name: 'Move to step' }).click();
    await expect(dialog).toBeHidden();
    expect((await orch.getTask(ctx.userA, task.id)).currentStepId).toBe('plan-review');
    expect((await ctx.repo.listJobsForTask(ctx.userA, task.id)).every((job) => job.status === 'cancelled')).toBe(true);

    await page.getByRole('button', { name: 'Change workflow' }).click();
    await dialog.getByLabel('Destination step').selectOption('implement');
    await expect(dialog.getByText('Missing prerequisites', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Move and run agent' })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Move and run agent' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Agent is working', { exact: true })).toBeVisible();
    const moved = await orch.getTask(ctx.userA, task.id);
    expect(moved).toMatchObject({ workflowId: destination.id, currentStepId: 'implement', state: 'implement', pinnedWorkflow: { id: destination.id } });
    const queued = (await ctx.repo.listJobsForTask(ctx.userA, task.id)).filter((job) => job.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ kind: 'agent', step: { id: 'implement', engine: 'claude' } });
  } finally {
    await ctx.app.close();
  }
});
