begin;
select plan(23);

select ok(not has_table_privilege('authenticated', 'public.user_secrets', 'SELECT'), 'authenticated cannot select user secrets');
select ok(not has_table_privilege('authenticated', 'public.worker_keys', 'SELECT'), 'authenticated cannot select worker keys');
select ok(not has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT'), 'authenticated cannot select idempotency records');
select ok(not has_table_privilege('authenticated', 'public.webhook_deliveries', 'SELECT'), 'authenticated cannot select webhook deliveries');
select ok(not has_table_privilege('authenticated', 'public.artifact_storage_deletions', 'SELECT'), 'authenticated cannot select artifact deletion queue');

select ok(not has_table_privilege('authenticated', 'public.workers', 'INSERT'), 'authenticated cannot insert workers');
select ok(not has_table_privilege('authenticated', 'public.workflows', 'INSERT'), 'authenticated cannot insert workflows');
select ok(not has_table_privilege('authenticated', 'public.tasks', 'INSERT'), 'authenticated cannot insert tasks');
select ok(not has_table_privilege('authenticated', 'public.task_messages', 'INSERT'), 'authenticated cannot insert messages');
select ok(not has_table_privilege('authenticated', 'public.task_events', 'INSERT'), 'authenticated cannot insert events');
select ok(not has_table_privilege('authenticated', 'public.task_artifacts', 'INSERT'), 'authenticated cannot insert artifacts');
select ok(not has_table_privilege('authenticated', 'public.jobs', 'INSERT'), 'authenticated cannot insert jobs');
select ok(not has_table_privilege('authenticated', 'public.job_logs', 'INSERT'), 'authenticated cannot insert job logs');
select ok(not has_table_privilege('authenticated', 'public.task_repositories', 'INSERT'), 'authenticated cannot insert task repositories');
select ok(not has_table_privilege('authenticated', 'public.pull_requests', 'INSERT'), 'authenticated cannot insert pull requests');

select ok(not has_table_privilege('authenticated', 'public.workers', 'UPDATE'), 'authenticated cannot update workers');
select ok(not has_table_privilege('authenticated', 'public.workflows', 'UPDATE'), 'authenticated cannot update workflows');
select ok(not has_table_privilege('authenticated', 'public.tasks', 'UPDATE'), 'authenticated cannot update tasks');
select ok(not has_table_privilege('authenticated', 'public.task_messages', 'DELETE'), 'authenticated cannot delete messages');
select ok(not has_table_privilege('authenticated', 'public.task_events', 'DELETE'), 'authenticated cannot delete events');
select ok(not has_table_privilege('authenticated', 'public.task_artifacts', 'DELETE'), 'authenticated cannot delete artifacts');
select ok(not has_table_privilege('authenticated', 'public.task_repositories', 'DELETE'), 'authenticated cannot delete task repositories');
select ok(not has_table_privilege('authenticated', 'public.pull_requests', 'DELETE'), 'authenticated cannot delete pull requests');

select * from finish();
rollback;
