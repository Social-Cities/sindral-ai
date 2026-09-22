begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

select results_eq(
  $$select tablename from pg_tables where schemaname = 'public' and rowsecurity and tablename in (
    'profiles', 'user_secrets', 'worker_keys', 'workers', 'workflows', 'tasks',
    'task_messages', 'task_events', 'task_artifacts', 'jobs', 'job_logs',
    'task_repositories', 'pull_requests', 'idempotency_keys', 'webhook_deliveries',
    'artifact_storage_deletions'
  ) order by tablename$$,
  $$values
    ('artifact_storage_deletions'::name), ('idempotency_keys'::name), ('job_logs'::name),
    ('jobs'::name), ('profiles'::name), ('pull_requests'::name), ('task_artifacts'::name),
    ('task_events'::name), ('task_messages'::name), ('task_repositories'::name),
    ('tasks'::name), ('user_secrets'::name), ('webhook_deliveries'::name),
    ('worker_keys'::name), ('workers'::name), ('workflows'::name)$$,
  'every Sindral table has row-level security enabled'
);

select ok(not has_table_privilege('authenticated', 'public.user_secrets', 'SELECT'), 'browser cannot read encrypted provider secrets');
select ok(not has_table_privilege('authenticated', 'public.worker_keys', 'SELECT'), 'browser cannot read worker key hashes');
select ok(not has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT'), 'browser cannot read the command ledger');
select ok(not has_table_privilege('authenticated', 'public.webhook_deliveries', 'SELECT'), 'browser cannot read webhook delivery records');
select ok(not has_table_privilege('authenticated', 'public.artifact_storage_deletions', 'SELECT'), 'browser cannot read storage cleanup records');

insert into auth.users (id, email) values
  ('91000000-0000-4000-8000-000000000091', 'tenant-a@example.test'),
  ('92000000-0000-4000-8000-000000000092', 'tenant-b@example.test');

insert into public.worker_keys (id, user_id, name, key_hash, key_prefix) values
  ('91100000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'worker-a', repeat('a', 64), 'sk_a'),
  ('92100000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'worker-b', repeat('b', 64), 'sk_b');
insert into public.workers (id, user_id, worker_key_id, name, hostname, version) values
  ('91200000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', '91100000-0000-4000-8000-000000000091', 'worker-a', 'host-a', 'worker/1'),
  ('92200000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', '92100000-0000-4000-8000-000000000092', 'worker-b', 'host-b', 'worker/1');
insert into public.workflows (id, user_id, name, definition) values
  ('91300000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'workflow-a', '{}'::jsonb),
  ('92300000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'workflow-b', '{}'::jsonb);
insert into public.tasks (id, user_id, key, title, workflow_id) values
  ('91400000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'A-1', 'tenant a', '91300000-0000-4000-8000-000000000091'),
  ('92400000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'B-1', 'tenant b', '92300000-0000-4000-8000-000000000092');
insert into public.task_messages (id, task_id, user_id, role, content) values
  ('91500000-0000-4000-8000-000000000091', '91400000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'user', 'a'),
  ('92500000-0000-4000-8000-000000000092', '92400000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'user', 'b');
insert into public.task_events (id, task_id, user_id, type) values
  ('91600000-0000-4000-8000-000000000091', '91400000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'created'),
  ('92600000-0000-4000-8000-000000000092', '92400000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'created');
insert into public.task_artifacts (id, task_id, user_id, name, content_type, content, byte_size) values
  ('91700000-0000-4000-8000-000000000091', '91400000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'a.md', 'text/markdown', 'a', 1),
  ('92700000-0000-4000-8000-000000000092', '92400000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'b.md', 'text/markdown', 'b', 1);
insert into public.jobs (id, user_id, task_id, kind, status, payload) values
  ('91800000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', '91400000-0000-4000-8000-000000000091', 'agent', 'queued', '{"kind":"agent"}'::jsonb),
  ('92800000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', '92400000-0000-4000-8000-000000000092', 'agent', 'queued', '{"kind":"agent"}'::jsonb);
insert into public.job_logs (job_id, user_id, type, message) values
  ('91800000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', 'log', 'a'),
  ('92800000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', 'log', 'b');
insert into public.task_repositories (id, user_id, task_id, repository, branch) values
  ('91900000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', '91400000-0000-4000-8000-000000000091', 'acme/a', 'sindral/a'),
  ('92900000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', '92400000-0000-4000-8000-000000000092', 'acme/b', 'sindral/b');
insert into public.pull_requests (id, user_id, task_id, task_repository_id, repository, url, number, branch, base_branch) values
  ('91a00000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000091', '91400000-0000-4000-8000-000000000091', '91900000-0000-4000-8000-000000000091', 'acme/a', 'https://github.com/acme/a/pull/1', 1, 'sindral/a', 'main'),
  ('92a00000-0000-4000-8000-000000000092', '92000000-0000-4000-8000-000000000092', '92400000-0000-4000-8000-000000000092', '92900000-0000-4000-8000-000000000092', 'acme/b', 'https://github.com/acme/b/pull/2', 2, 'sindral/b', 'main');

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000091', true);
select results_eq(
  $$select relation, rows from (
    select 'profiles'::text relation, count(*)::bigint rows from public.profiles
    union all select 'pull_requests', count(*) from public.pull_requests
    union all select 'task_artifacts', count(*) from public.task_artifacts
    union all select 'task_events', count(*) from public.task_events
    union all select 'task_messages', count(*) from public.task_messages
    union all select 'task_repositories', count(*) from public.task_repositories
    union all select 'tasks', count(*) from public.tasks
    union all select 'workers', count(*) from public.workers
    union all select 'workflows', count(*) from public.workflows
    union all select 'jobs', count(*) from public.jobs
    union all select 'job_logs', count(*) from public.job_logs
  ) scoped order by relation$$,
  $$values
    ('job_logs'::text, 1::bigint), ('jobs', 1::bigint), ('profiles', 1::bigint),
    ('pull_requests', 1::bigint), ('task_artifacts', 1::bigint), ('task_events', 1::bigint),
    ('task_messages', 1::bigint), ('task_repositories', 1::bigint), ('tasks', 1::bigint),
    ('workers', 1::bigint), ('workflows', 1::bigint)$$,
  'authenticated users see exactly their own row in every browser-readable table'
);

select throws_ok(
  $$insert into public.tasks (user_id, key, title) values ('91000000-0000-4000-8000-000000000091', 'DIRECT-1', 'direct write')$$,
  '42501',
  null,
  'authenticated users cannot write tasks directly'
);
select is(
  (select count(*) from public.tasks where id = '92400000-0000-4000-8000-000000000092'),
  0::bigint,
  'cross-tenant task lookup is indistinguishable from a missing task'
);

reset role;
select is((select count(*) from public.tasks where id in ('91400000-0000-4000-8000-000000000091', '92400000-0000-4000-8000-000000000092')), 2::bigint, 'service database context retains both tenant rows');

select * from finish();
rollback;
