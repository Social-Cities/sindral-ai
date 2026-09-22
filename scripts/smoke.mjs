#!/usr/bin/env node
/**
 * Live smoke test: drives the real server against a real Supabase instance.
 *
 *   supabase start
 *   pnpm --filter @sindral/server build
 *   node apps/server/dist/index.js                     # in another shell
 *   SMOKE_ANON_KEY=<anon key> SMOKE_WEBHOOK_SECRET=<GITHUB_WEBHOOK_SECRET> pnpm smoke
 *
 * Covers the full happy path (create -> plan -> feedback -> approve -> subtasks),
 * worker job claiming and fencing, auth/tenant isolation, webhook HMAC, and
 * Postgres row-level security. Exits non-zero on the first failed assertion.
 */
const SUPA = process.env.SMOKE_SUPABASE ?? 'http://127.0.0.1:54321';
const ANON = process.env.SMOKE_ANON_KEY ?? process.env.ANON;
const API = process.env.SMOKE_API ?? 'http://127.0.0.1:8787';
const WEBHOOK_SECRET = process.env.SMOKE_WEBHOOK_SECRET ?? 'smoke-webhook-secret';
const email = `smoke+${Date.now()}@example.com`;
const password = 'Smoke-test-pass-123!';
let step = 0;
const ok = (cond, msg) => { step++; if (!cond) { console.error(`FAIL ${step}: ${msg}`); process.exit(1); } console.log(`ok ${step}: ${msg}`); };

async function j(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
// 1. sign up
const su = await j(`${SUPA}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
ok(su.status === 200 && su.body.access_token, `signup via Supabase Auth (${su.status})`);
const token = su.body.access_token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (p, init = {}) => {
  // Only send a JSON content-type when there is actually a body (matches the web client).
  const headers = init.body ? { ...H, ...(init.headers ?? {}) } : { authorization: H.authorization, ...(init.headers ?? {}) };
  return j(`${API}${p}`, { ...init, headers });
};
let actionSequence = 0;
const action = async (taskId, event) => {
  const current = await api(`/api/tasks/${taskId}`);
  actionSequence += 1;
  return api(`/api/tasks/${taskId}/actions`, {
    method: 'POST',
    headers: { 'idempotency-key': `smoke-action-${actionSequence}` },
    body: JSON.stringify({ event, expectedVersion: current.body.task.version }),
  });
};

ok((await j(`${API}/api/tasks`)).status === 401, 'unauthenticated request rejected with 401');
const me = await api('/api/me'); ok(me.status === 200 && me.body.user.email === email, 'GET /api/me');
const wfs = await api('/api/workflows'); ok(wfs.status === 200 && wfs.body.workflows.length === 4, `bundled workflows seeded (${wfs.body.workflows.length})`);
const def = wfs.body.workflows.find((w) => w.isDefault); ok(def?.name === 'Full SDLC', 'Full SDLC is default');

// create task
const ct = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Add rate limiting to login', description: 'Limit failed logins per IP.', repos: ['acme/app'] }) });
ok(ct.status === 201 && ct.body.task.key === 'SIN-1' && ct.body.task.state === 'todo', `task created ${ct.body.task?.key}`);
const taskId = ct.body.task.id;
const bad = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '', repos: ['../x'] }) });
ok(bad.status === 400 && bad.body.error.code === 'VALIDATION_ERROR', 'validation error on bad task input');

// start planning -> job queued
const st = await action(taskId, 'start');
ok(st.status === 200 && st.body.task.state === 'planning' && st.body.task.pinnedWorkflow, 'start -> planning, workflow pinned');
const inv = await action(taskId, 'approve');
ok(inv.status === 409, 'invalid transition -> 409');

// worker key + register + claim (exercises claim_jobs SQL)
const wk = await api('/api/settings/worker-keys', { method: 'POST', body: JSON.stringify({ name: 'laptop' }) });
ok(wk.status === 201 && wk.body.secret.startsWith('sk_sindral_'), 'worker key created');
const WH = { authorization: `Bearer ${wk.body.secret}`, 'content-type': 'application/json' };
const w = (p, body) => j(`${API}${p}`, { method: 'POST', headers: WH, body: JSON.stringify(body) });
const reg = await w('/api/worker/register', { name: 'laptop', hostname: 'mac', version: 'worker/0.1.0' });
ok(reg.status === 200 && reg.body.workerId, 'worker registered');
const claim = await w('/api/worker/jobs/claim', { workerId: reg.body.workerId, max: 2 });
ok(claim.status === 200 && claim.body.jobs.length === 1 && claim.body.jobs[0].job.payload.step.id === 'planning', 'worker claimed planning job via claim_jobs()');
const jobDispatch = claim.body.jobs[0];
const job = jobDispatch.job;
ok(claim.body.jobs[0].credentials.githubToken === null, 'no github token yet -> null credential');
const claim2 = await w('/api/worker/jobs/claim', { workerId: reg.body.workerId, max: 2 });
ok(claim2.body.jobs.length === 0, 'second claim returns nothing (job serialised)');
await w(`/api/worker/jobs/${job.id}/events`, { type: 'log', message: 'hello from agent', attempt: job.attempt, leaseToken: jobDispatch.lease.token });

// complete planning with subtasks
const stale = await w(`/api/worker/jobs/${job.id}/complete`, { attempt: job.attempt + 5, leaseToken: jobDispatch.lease.token, result: { kind: 'plan', summary: 'x', plan: 'x' } });
ok(stale.status === 409 || stale.status === 400, `stale attempt token rejected (${stale.status})`);
const comp = await w(`/api/worker/jobs/${job.id}/complete`, { attempt: job.attempt, leaseToken: jobDispatch.lease.token, result: { kind: 'plan', summary: 'Plan ready.', plan: '# Plan\n\n- do it', subtasks: [{ title: 'Part 1', goal: 'db' }, { title: 'Part 2', goal: 'api' }] } });
ok(comp.status === 200, `planning job completed (${comp.status} ${JSON.stringify(comp.body).slice(0, 120)})`);
let t = (await api(`/api/tasks/${taskId}`)).body.task;
ok(t.state === 'plan-review' && t.plan.includes('# Plan') && t.subtasks.length === 2, `plan-review with ${t.subtasks.length} subtasks`);
ok(t.messages.some((m) => m.role === 'agent' && m.content === 'Plan ready.'), 'agent summary message recorded');

// feedback loop
const fb = await api(`/api/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ content: 'Please split step 2.' }) });
ok(fb.status === 201 && fb.body.task.state === 'planning-feedback', 'chat feedback -> planning-feedback');
const c3 = await w('/api/worker/jobs/claim', { workerId: reg.body.workerId, max: 1 });
ok(c3.body.jobs.length === 1 && c3.body.jobs[0].job.payload.context.feedback.includes('split step 2'), 'revision job carries user feedback in context');
await w(`/api/worker/jobs/${c3.body.jobs[0].job.id}/complete`, { attempt: c3.body.jobs[0].job.attempt, leaseToken: c3.body.jobs[0].lease.token, result: { kind: 'plan', summary: 'Revised.', plan: '# Plan v2' } });
t = (await api(`/api/tasks/${taskId}`)).body.task; ok(t.state === 'plan-review' && t.plan === '# Plan v2', 'back to plan-review with revised plan');

// approve -> subtask 1 starts instead of parent implement
const ap = await action(taskId, 'approve');
ok(ap.status === 200 && ap.body.task.state === 'implement', 'approve -> parent implement');
const c4 = await w('/api/worker/jobs/claim', { workerId: reg.body.workerId, max: 3 });
ok(c4.body.jobs.length === 1 && c4.body.jobs[0].job.taskId !== taskId && c4.body.jobs[0].job.payload.step.id === 'planning', 'subtask #1 planning dispatched (not parent implement)');
ok(c4.body.jobs[0].job.payload.context.parent_plan === '# Plan v2', 'subtask job carries parent plan');

// secrets + list + diff guard + delete
const sec = await api('/api/settings/secrets', { method: 'PUT', body: JSON.stringify({ provider: 'github', token: 'ghp_smoketoken1234' }) });
ok(sec.status === 200 && sec.body.secret.configured && sec.body.secret.hint === '1234', 'github token stored encrypted with hint');
const list = await api('/api/tasks'); ok(list.body.tasks.length === 1, 'top-level list hides subtasks');
const listAll = await api('/api/tasks?includeSubtasks=true'); ok(listAll.body.tasks.length === 3, 'includeSubtasks lists children');
const ev = await api(`/api/tasks/${taskId}/events`); ok(ev.body.events.some((e) => e.type === 'subtasks-created'), 'audit events recorded');

// private artifact storage: small text remains inline; larger text is signed on demand
const documentWorkflow = wfs.body.workflows.find((workflow) => workflow.name === 'Document (non-code)');
const documentTask = await api('/api/tasks', {
  method: 'POST',
  body: JSON.stringify({ title: 'Write a large research brief', description: 'Exercise private artifact storage.', workflowId: documentWorkflow.id }),
});
ok(documentTask.status === 201, 'document task created');
const documentTaskId = documentTask.body.task.id;
const documentStart = await action(documentTaskId, 'start');
ok(documentStart.status === 200, 'document workflow started');
const documentClaim = await w('/api/worker/jobs/claim', { workerId: reg.body.workerId, max: 1 });
ok(documentClaim.body.jobs.length === 1 && documentClaim.body.jobs[0].job.taskId === documentTaskId, 'worker claimed document job');
const documentJob = documentClaim.body.jobs[0].job;
const largeContent = `# Research brief\n\n${'private artifact content '.repeat(3200)}`;
const documentComplete = await w(`/api/worker/jobs/${documentJob.id}/complete`, {
  attempt: documentJob.attempt,
  leaseToken: documentClaim.body.jobs[0].lease.token,
  result: {
    kind: 'document',
    summary: 'Research brief ready.',
    artifacts: [
      { name: 'summary.md', contentType: 'text/markdown', content: '# Summary' },
      { name: 'research.md', contentType: 'text/markdown', content: largeContent },
    ],
  },
});
ok(documentComplete.status === 200, `document job completed (${documentComplete.status})`);
const artifactsResponse = await api(`/api/tasks/${documentTaskId}/artifacts`);
const smallArtifact = artifactsResponse.body.artifacts.find((artifact) => artifact.name === 'summary.md');
const largeArtifact = artifactsResponse.body.artifacts.find((artifact) => artifact.name === 'research.md');
ok(smallArtifact.content === '# Summary' && smallArtifact.downloadUrl === null, 'small artifact remains inline');
ok(largeArtifact.content === null && largeArtifact.byteSize > 65536 && largeArtifact.downloadUrl && !('storagePath' in largeArtifact), 'large artifact exposes only a signed download');
const artifactDownload = await fetch(largeArtifact.downloadUrl);
ok(artifactDownload.status === 200 && await artifactDownload.text() === largeContent, 'signed artifact download returns exact content');

// webhook HMAC
const crypto = await import('node:crypto');
const raw = JSON.stringify({ action: 'created', comment: { id: 1, body: 'x', user: { login: 'a' } }, issue: { pull_request: { html_url: 'https://github.com/acme/app/pull/1' } } });
const badSig = await j(`${API}/api/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-hub-signature-256': 'sha256=deadbeef' }, body: raw });
ok(badSig.status === 401, 'webhook with bad signature rejected');
const sig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
const goodSig = await j(`${API}/api/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-github-delivery': `smoke-${Date.now()}`, 'x-hub-signature-256': sig }, body: raw });
ok(goodSig.status === 202, 'webhook with valid signature accepted (no matching PR -> ignored)');

// cross-user isolation
const su2 = await j(`${SUPA}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email: `other+${Date.now()}@example.com`, password }) });
const other = await j(`${API}/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${su2.body.access_token}` } });
ok(other.status === 404, 'other user cannot see the task (404)');
const otherArtifacts = await j(`${API}/api/tasks/${documentTaskId}/artifacts`, { headers: { authorization: `Bearer ${su2.body.access_token}` } });
ok(otherArtifacts.status === 404, 'other user cannot mint artifact download URLs');

const del = await api(`/api/tasks/${taskId}`, { method: 'DELETE' }); ok(del.status === 200, 'task deleted');
const delDocument = await api(`/api/tasks/${documentTaskId}`, { method: 'DELETE' }); ok(delDocument.status === 200, 'document task deleted');
const deletedArtifactDownload = await fetch(largeArtifact.downloadUrl);
ok([400, 404].includes(deletedArtifactDownload.status), `stored artifact removed with task (${deletedArtifactDownload.status})`);
ok((await api(`/api/tasks/${taskId}`)).status === 404, 'deleted task is gone');
ok((await api('/api/tasks?includeSubtasks=true')).body.tasks.length === 0, 'subtasks cascade-deleted with the parent');
// ---- Row level security: the anon key + a user JWT must only ever see that user's rows ----
const rest = (tok, path) => j(`${SUPA}/rest/v1/${path}`, { headers: { apikey: ANON, authorization: `Bearer ${tok}` } });
const tokenB = su2.body.access_token;
const probe = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'RLS probe', description: 'x' }) });
ok(probe.status === 201, 'created a task for the RLS probe');
const aRows = await rest(token, 'tasks?select=id,title');
ok(aRows.status === 200 && Array.isArray(aRows.body) && aRows.body.some((r) => r.title === 'RLS probe'), 'owner reads their own task through PostgREST');
const bRows = await rest(tokenB, 'tasks?select=id,title');
ok(bRows.status === 200 && Array.isArray(bRows.body) && bRows.body.length === 0, "RLS hides other users' tasks from a direct PostgREST read");
for (const table of ['user_secrets', 'worker_keys']) {
  const r = await rest(token, `${table}?select=*`);
  const denied = r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0);
  ok(denied, `RLS denies direct client reads of ${table} (status ${r.status})`);
}
const directWrite = await j(`${SUPA}/rest/v1/tasks`, {
  method: 'POST',
  headers: { apikey: ANON, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'direct write', key: 'X-1' }),
});
ok(directWrite.status >= 400, `RLS blocks direct client writes to tasks (status ${directWrite.status})`);

console.log('SMOKE PASSED');
