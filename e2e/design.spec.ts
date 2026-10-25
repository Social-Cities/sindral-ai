import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { DESIGN_WORKFLOW, snapshotWorkflow, type DesignRevision } from '../packages/shared/dist/index.js';
import { DESIGN_PREVIEW_CSP } from '../apps/server/src/services/designs.js';
import { installMockBackend, makeTask, signIn } from './mockBackend';

test('reviews an interactive design, sends feedback, approves a revision, and creates a pinned implementation task', async ({ page }) => {
  const task = makeTask({ id: 'design-task', title: 'Project dashboard', state: 'design-review', currentStepId: 'design-review', workflowId: DESIGN_WORKFLOW.id, pinnedWorkflow: snapshotWorkflow(DESIGN_WORKFLOW) });
  const backend = await installMockBackend(page, { tasks: [task] });
  const html = '<!doctype html><html><head><style>body{margin:0;font:16px system-ui;background:#f4f5f8;color:#182334;padding:32px}h1{font-size:28px}button{border:0;border-radius:8px;padding:12px 20px;background:#314ccc;color:white}</style></head><body><h1>Project dashboard</h1><p>Keep your team moving.</p><button onclick="this.textContent=\'Project created\'">New project</button></body></html>';
  const revision: DesignRevision = { id: 'revision-1', taskId: task.id, jobId: 'job-1', approvedAt: null, createdAt: task.createdAt,
    result: { kind: 'design', summary: 'Project dashboard with a primary create action.', designUrl: 'https://claude.ai/code/artifact/example', specification: '# Implementation specification\n\nBuild the dashboard with responsive navigation, loading states, and accessible controls.', questions: [], screens: [{ name: 'Dashboard', path: 'index.html' }], files: [{ path: 'index.html', contentType: 'text/html', content: html, encoding: 'utf8', sha256: createHash('sha256').update(html).digest('hex') }] } };
  await page.route('**/api/tasks/design-task/design**', async (route) => {
    if (route.request().method() === 'POST') { expect(route.request().postDataJSON()).toMatchObject({ revisionId: revision.id, expectedVersion: task.version }); revision.approvedAt = '2026-10-25T12:00:00Z'; return route.fulfill({ json: { revision } }); }
    if (new URL(route.request().url()).pathname.endsWith('revision-1')) return route.fulfill({ json: { revision, previewUrls: ['/api/design-previews/design-task?token=fixture'] } });
    return route.fulfill({ json: { revisions: [{ ...revision, summary: revision.result.summary, designUrl: revision.result.designUrl, screens: revision.result.screens }], checkpointAt: task.updatedAt, input: null, inputPreviewUrls: [] } });
  });
  await page.route('**/api/design-previews/**', (route) => route.fulfill({ contentType: 'text/html', body: html, headers: { 'Content-Security-Policy': `${DESIGN_PREVIEW_CSP}; frame-ancestors 'self'`, 'Cache-Control': 'no-store' } }));
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);
  const preview = page.frameLocator('iframe[title="Design preview: Dashboard"]');
  await expect(preview.getByRole('heading', { name: 'Project dashboard' })).toBeVisible();
  await preview.getByRole('button', { name: 'New project' }).click();
  await expect(preview.getByRole('button', { name: 'Project created' })).toBeVisible();
  const iframe = page.frames().find((frame) => frame.url().includes('/api/design-previews/'))!;
  expect(await iframe.evaluate(() => { try { void window.parent.document; return false; } catch { return true; } })).toBe(true);
  await page.screenshot({ path: 'test-results/design-desktop.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Make the primary action easier to find.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('Make the primary action easier to find.');
  await page.getByRole('button', { name: 'Approve revision' }).click();
  await page.getByRole('button', { name: 'Create implementation task' }).click();
  await page.getByRole('textbox', { name: 'Repositories', exact: true }).fill('acme/app');
  await page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/task-2$/);
  const creation = backend.requests.find((request) => request.method === 'POST' && request.path === '/api/tasks');
  expect(creation?.body).toMatchObject({ repos: ['acme/app'], designHandoff: { revisionId: 'revision-1' } });
  await page.goto(`/tasks/${task.id}`);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByTitle('Design preview: Dashboard')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/design-tablet.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Design workspace panel' }).getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByTitle('Design preview: Dashboard')).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Project dashboard' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/design-phone.png', fullPage: true });
});

test('starts a design from the home page without a repository', async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.route('**/api/tasks/*/design', (route) => route.fulfill({ json: { revisions: [], checkpointAt: null, input: null, inputPreviewUrls: [] } }));
  await signIn(page);
  await page.getByRole('tab', { name: 'Design an app' }).click();
  await page.getByLabel('Task description').fill('We want to build a meal planning app with a weekly calendar.');
  await page.getByRole('button', { name: 'Create design' }).click();
  await expect(page).toHaveURL(/\/tasks\/task-1$/);
  expect(backend.tasks[0]?.workflowId).toBe(DESIGN_WORKFLOW.id);
  expect(backend.tasks[0]?.repos).toEqual([]);
  await expect(page.getByRole('button', { name: 'Start designing' })).toBeVisible();
});
