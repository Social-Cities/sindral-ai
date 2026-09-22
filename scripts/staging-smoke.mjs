#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Controlled staging smoke test.
 *
 * This intentionally refuses to run without an explicit mutation acknowledgement.
 * A compatible worker must already be online with real GitHub/agent credentials.
 * The sandbox repository should delete merged branches automatically.
 */
const API = required('STAGING_API_URL').replace(/\/$/, '');
const TOKEN = required('STAGING_ACCESS_TOKEN');
const REPOSITORY = required('STAGING_REPOSITORY');
const ISSUE_URL = required('STAGING_GITHUB_ISSUE_URL');
const ACK = required('STAGING_ALLOW_MUTATIONS');
const TIMEOUT_MS = numberEnv('STAGING_TIMEOUT_MS', 45 * 60_000);
const POLL_MS = numberEnv('STAGING_POLL_MS', 5_000);
const EVIDENCE_PATH = process.env.STAGING_EVIDENCE_PATH?.trim();

if (ACK !== 'yes') fail('STAGING_ALLOW_MUTATIONS must be exactly "yes"');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPOSITORY)) fail('STAGING_REPOSITORY must be owner/name');
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:$|[?#])/.test(ISSUE_URL)) {
  fail('STAGING_GITHUB_ISSUE_URL must be a github.com issue URL');
}

const startedAt = new Date().toISOString();
const runId = `staging-${Date.now()}`;
const createdTaskIds = [];
const evidence = { runId, startedAt, api: API, repository: REPOSITORY, tasks: [], result: 'running' };

try {
  await assertReadiness();
  const workflows = (await api('/api/workflows')).workflows;
  const full = workflows.find((workflow) => workflow.isDefault);
  const document = workflows.find((workflow) => workflow.name === 'Document (non-code)');
  assert(full, 'Default workflow is unavailable');
  assert(document, 'Document (non-code) workflow is unavailable');

  const imported = (await api('/api/tickets/import', { method: 'POST', json: { url: ISSUE_URL } })).ticket;
  const fixtures = [
    {
      mode: 'free-text',
      input: {
        title: `[${runId}] Free-text staging smoke`,
        description: 'Make one harmless, easily reviewable documentation improvement for the staging smoke test.',
        repos: [REPOSITORY],
        workflowId: full.id,
      },
    },
    {
      mode: 'uploaded-plan',
      input: {
        title: `[${runId}] Uploaded-plan staging smoke`,
        description: '# Approved test plan\n\n1. Make one harmless documentation-only change.\n2. Run the repository checks.\n3. Open a pull request.',
        repos: [REPOSITORY],
        workflowId: full.id,
      },
    },
    {
      mode: 'ticket-url',
      input: {
        title: `[${runId}] ${imported.title}`,
        description: imported.description || 'Implement the linked sandbox issue with the smallest safe change.',
        ticketUrl: imported.url,
        repos: [REPOSITORY],
        workflowId: full.id,
      },
    },
    {
      mode: 'non-code',
      input: {
        title: `[${runId}] Non-code artifact smoke`,
        description: 'Create a short Markdown release-readiness note for this staging run.',
        repos: [],
        workflowId: document.id,
      },
    },
  ];

  for (const fixture of fixtures) {
    const task = (await api('/api/tasks', { method: 'POST', json: fixture.input })).task;
    createdTaskIds.push(task.id);
    process.stdout.write(`created ${fixture.mode} task ${task.key} (${task.id})\n`);
    await action(task, 'start');
    const completed = await driveToDone(task.id);
    const taskEvidence = await verifyCompletedTask(fixture.mode, completed);
    evidence.tasks.push(taskEvidence);
  }

  evidence.result = 'passed';
  evidence.finishedAt = new Date().toISOString();
  await emitEvidence(evidence);
  process.stdout.write(`STAGING SMOKE PASSED (${runId})\n`);
} catch (error) {
  evidence.result = 'failed';
  evidence.finishedAt = new Date().toISOString();
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.createdTaskIds = createdTaskIds;
  await emitEvidence(evidence).catch(() => {});
  throw error;
}

async function assertReadiness() {
  const health = await request('/api/health', {}, false);
  assert(health.response.ok, `Health check failed (${health.response.status})`);
  const me = await api('/api/me');
  assert(me.user?.id, 'Access token does not identify a user');
  const workers = await api('/api/workers');
  assert(workers.workers?.some((worker) => worker.status !== 'offline'), 'No staging worker is online');
}

async function driveToDone(rootTaskId) {
  const deadline = Date.now() + TIMEOUT_MS;
  const approvedVersions = new Set();
  while (Date.now() < deadline) {
    const root = (await api(`/api/tasks/${rootTaskId}`)).task;
    const all = (await api('/api/tasks?includeSubtasks=true')).tasks;
    const relatedIds = new Set([rootTaskId]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const task of all) {
        if (task.parentTaskId && relatedIds.has(task.parentTaskId) && !relatedIds.has(task.id)) {
          relatedIds.add(task.id);
          foundDescendant = true;
        }
      }
    }
    const related = all.filter((task) => relatedIds.has(task.id));

    for (const task of related) {
      const actionKey = `${task.id}:${task.version}:${task.state}`;
      if (approvedVersions.has(actionKey)) continue;
      if (task.state === 'plan-review') {
        approvedVersions.add(actionKey);
        await action(task, 'approve');
      } else if (task.state === 'in-review') {
        approvedVersions.add(actionKey);
        await action(task, 'accept');
      } else if (task.state === 'failure') {
        throw new Error(`${task.key} failed: ${task.lastError || 'unknown error'}`);
      }
    }

    if (root.state === 'done') return root;
    process.stdout.write(`waiting ${root.key}: ${root.state}\n`);
    await delay(POLL_MS);
  }
  throw new Error(`Timed out after ${TIMEOUT_MS}ms waiting for task ${rootTaskId}`);
}

async function verifyCompletedTask(mode, task) {
  const detail = (await api(`/api/tasks/${task.id}`)).task;
  assert(detail.state === 'done', `${detail.key} is not done`);
  if (mode === 'non-code') {
    const artifacts = (await api(`/api/tasks/${task.id}/artifacts`)).artifacts;
    assert(artifacts.length > 0, `${detail.key} produced no artifact`);
    const accessible = artifacts.some((artifact) => typeof artifact.content === 'string' || typeof artifact.downloadUrl === 'string');
    assert(accessible, `${detail.key} has no accessible artifact`);
    return { mode, id: detail.id, key: detail.key, state: detail.state, artifacts: artifacts.map(({ name, byteSize }) => ({ name, byteSize })) };
  }

  assert(detail.pullRequests.length > 0, `${detail.key} produced no pull request`);
  assert(detail.pullRequests.every((pullRequest) => pullRequest.status === 'merged' && pullRequest.mergedAt), `${detail.key} has an unconfirmed merge`);
  assert(detail.pullRequests.every((pullRequest) => pullRequest.repository === REPOSITORY), `${detail.key} used a repository outside the sandbox`);
  return {
    mode,
    id: detail.id,
    key: detail.key,
    state: detail.state,
    pullRequests: detail.pullRequests.map(({ repository, number, url, headSha, mergedAt }) => ({ repository, number, url, headSha, mergedAt })),
  };
}

async function action(task, event) {
  return api(`/api/tasks/${task.id}/actions`, {
    method: 'POST',
    headers: { 'idempotency-key': `${runId}:${task.id}:${task.version}:${event}` },
    json: { event, expectedVersion: task.version },
  });
}

async function api(path, options = {}) {
  const { response, body } = await request(path, options, true);
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${stringify(body)}`);
  return body;
}

async function request(path, options, authenticated) {
  const headers = { ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}), ...(options.headers ?? {}) };
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

async function emitEvidence(value) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  if (EVIDENCE_PATH) {
    const target = resolve(EVIDENCE_PATH);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`evidence written to ${target}\n`);
  } else {
    process.stdout.write(output);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  process.stderr.write(`staging smoke: ${message}\n`);
  process.exit(2);
}

function stringify(value) {
  return typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
