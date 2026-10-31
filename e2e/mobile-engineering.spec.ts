import { expect, test } from '@playwright/test';
import { createMobileWorkflow } from '../packages/shared/dist/index.js';
import { installMockBackend, makeTask, signIn } from './mockBackend';

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
