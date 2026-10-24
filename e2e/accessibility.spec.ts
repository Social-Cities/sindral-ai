import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FULL_SDLC_WORKFLOW, snapshotWorkflow } from '../packages/shared/dist/index.js';
import { installMockBackend, makePullRequest, makeTask, signIn } from './mockBackend';

async function expectNoSeriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  const material = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(material, material.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`).join('\n')).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test(`login, home, tasks, and task review have no serious automated accessibility violations in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const task = makeTask({
      state: 'in-review',
      currentStepId: 'in-review',
      repos: ['acme/api'],
      prUrl: 'https://github.com/acme/api/pull/42',
      pullRequests: [makePullRequest()],
      pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
    });
    await installMockBackend(page, { tasks: [task] });
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expectNoSeriousViolations(page);
    await signIn(page);
    await expectNoSeriousViolations(page);
    await page.goto('/tasks');
    await expect(page.getByTestId('task-card')).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.goto(`/tasks/${task.id}`);
    await expect(page.getByRole('button', { name: 'Accept & merge' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}

test('core task screens reflow at tablet width without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const task = makeTask({ state: 'plan-review', currentStepId: 'plan-review', plan: '# Plan', pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW) });
  await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  await expect(page.locator('body')).toHaveCSS('overflow-x', 'visible');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/tasks');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto(`/tasks/${task.id}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible();
});

test('reduced-motion preference suppresses repeating status animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const task = makeTask({ state: 'planning', currentStepId: 'planning', pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW) });
  await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);
  const animated = page.locator('.animate-pulse').first();
  await expect(animated).toBeVisible();
  expect(await animated.evaluate((element) => getComputedStyle(element).animationIterationCount)).toBe('1');
});
