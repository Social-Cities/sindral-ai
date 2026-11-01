import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FULL_SDLC_WORKFLOW, snapshotWorkflow } from '../packages/shared/dist/index.js';
import { installMockBackend, makePullRequest, makeTask, signIn } from './mockBackend';
import { createTestApp, testConfig } from '../apps/server/src/test/helpers.js';

async function expectNoSeriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  const material = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(material, material.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`).join('\n')).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test(`login, home, tasks, and task review have no serious automated accessibility violations in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    // Exercise the deployed API's policy rather than Vite preview's open policy.
    const server = await createTestApp({ config: testConfig({ supabaseUrl: 'http://127.0.0.1:55321' }) });
    const health = await server.app.inject({ url: '/api/health' });
    const policy = String(health.headers['content-security-policy']);
    await server.app.close();
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      await route.fulfill({ response, headers: {
        ...response.headers(),
        'content-security-policy': policy,
        'cross-origin-embedder-policy': String(health.headers['cross-origin-embedder-policy']),
        'permissions-policy': String(health.headers['permissions-policy']),
      } });
    });
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
    await expect(page.getByTestId('status-badge').first()).toHaveCSS('background-color', 'rgba(34, 211, 238, 0.08)');
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

test('workflow action is fully readable as soon as workflow loading enables it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const task = makeTask({ state: 'plan-review', currentStepId: 'plan-review', pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW) });
  await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  let releaseWorkflows!: () => void;
  const workflowsReady = new Promise<void>((resolve) => { releaseWorkflows = resolve; });
  await page.route('**/api/workflows', async (route) => { await workflowsReady; await route.fallback(); });
  try {
    await page.goto(`/tasks/${task.id}`);
    const button = page.getByRole('button', { name: 'Change workflow' });
    await expect(button).toBeDisabled();
    // Capture the first enabled frame, before an opacity transition could finish.
    await button.evaluate((element) => {
      const observer = new MutationObserver(() => {
        if (element.hasAttribute('disabled')) return;
        element.setAttribute('data-enabled-opacity', getComputedStyle(element).opacity);
        observer.disconnect();
      });
      observer.observe(element, { attributes: true, attributeFilter: ['disabled'] });
      void getComputedStyle(element).opacity;
    });
    releaseWorkflows();
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('data-enabled-opacity', '1');
    await expectNoSeriousViolations(page);
  } finally {
    releaseWorkflows();
  }
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
