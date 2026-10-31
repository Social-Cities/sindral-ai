import { expect, test } from '@playwright/test';
import { createMobileWorkflow } from '../packages/shared/dist/index.js';
import { installMockBackend, makeProject, makeTask, signIn } from './mockBackend';

test('reviews BDD scenarios and targets revision feedback', async ({ page }) => {
  const task = makeTask({ state: 'plan-review', currentStepId: 'plan-review', pinnedWorkflow: createMobileWorkflow(), plan: '# Implementation plan\nUse the shared Supabase session.', bddPlan: { kind: 'bdd-plan', summary: 'Sign in', plan: '# BDD tests\nVerify sign in on iOS and Android.', scenarios: [{ id: 'BDD-login', given: 'Signed out', when: 'Valid credentials submitted', then: 'Session established' }] } });
  const backend = await installMockBackend(page, { tasks: [task] });
  await signIn(page);
  await page.goto(`/tasks/${task.id}?tab=plan`);
  await expect(page.getByRole('button', { name: 'Approve Both Plans' })).toBeVisible();
  await page.getByRole('tab', { name: 'BDD test plan' }).click();
  await expect(page.getByText('BDD-login')).toBeVisible();
  await expect(page.getByText('Session established')).toBeVisible();
  await page.getByLabel('Feedback for').selectOption('bdd');
  await page.getByLabel('Plan feedback').fill('Add an expired-session scenario.');
  await page.getByRole('button', { name: 'Request plan changes' }).click();
  await expect.poll(() => backend.requests.find((request) => request.path.endsWith('/messages'))?.body).toEqual({ content: 'Add an expired-session scenario.', feedbackTarget: 'bdd' });
});

test('mobile projects default to iOS and Android with optional Web', async ({ page }) => {
  await installMockBackend(page);
  await signIn(page);
  await page.getByRole('tab', { name: 'New project' }).click();
  await page.getByLabel('Project type').selectOption('mobile-app');
  await expect(page.getByRole('checkbox', { name: 'iOS', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Android', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Web', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Web', exact: true }).check();
  await expect(page.getByText(/One monorepo with ios/)).toBeVisible();
  await page.screenshot({ path: '/tmp/sindral-mobile-project.png', fullPage: true });
});

test('selects task platforms and previews only their steps before and after starting', async ({ page }) => {
  const backend = await installMockBackend(page, { projects: [makeProject({ projectType: 'mobile-app', platforms: ['ios', 'android', 'web'] })] });
  await signIn(page);
  const selection = page.getByRole('group', { name: 'Platforms for this task' });
  await expect(selection.getByRole('checkbox', { name: 'Android', exact: true })).toBeChecked();
  await selection.getByRole('checkbox', { name: 'Android', exact: true }).uncheck();
  await page.getByLabel('Task description').fill('Update account preferences');
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  expect(backend.tasks[0]!.platforms).toEqual(['ios', 'web']);
  await page.goto(`/tasks/${backend.tasks[0]!.id}`);
  const pipeline = page.getByRole('list', { name: 'Pipeline' });
  await expect(pipeline).toContainText('Implement iOS');
  await expect(pipeline).toContainText('Implement Web');
  await expect(pipeline).not.toContainText('Implement Android');
  const web = page.getByRole('group', { name: 'Platforms for this task' }).getByRole('checkbox', { name: 'Web', exact: true });
  await web.click();
  await expect(web).not.toBeChecked();
  await expect(pipeline).not.toContainText('Implement Web');
  await page.screenshot({ path: '/tmp/sindral-ios-only-task.png', fullPage: true });
  await page.getByRole('button', { name: 'Start Planning' }).click();
  await expect.poll(() => backend.tasks[0]!.pinnedWorkflow?.mobilePlatforms).toEqual(['ios']);
  await expect(pipeline).not.toContainText('Implement Android');
  await expect(pipeline).not.toContainText('Implement Web');
});
