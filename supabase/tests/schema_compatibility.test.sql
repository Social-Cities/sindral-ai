begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

select is(public.sindral_schema_version(), '20261031171422', 'database reports the server-compatible migration version');
select ok(not has_function_privilege('authenticated', 'public.sindral_schema_version()', 'EXECUTE'), 'browser role cannot call the compatibility probe');
select ok(has_function_privilege('service_role', 'public.sindral_schema_version()', 'EXECUTE'), 'service role can call the compatibility probe');
select ok(not has_function_privilege('authenticated', 'public.sindral_operational_snapshot()', 'EXECUTE'), 'browser role cannot read cross-tenant aggregates');
select ok(has_function_privilege('service_role', 'public.sindral_operational_snapshot()', 'EXECUTE'), 'service role can read operational aggregates');
select has_column('public', 'tasks', 'outcome', 'tasks store a durable outcome');
select col_not_null('public', 'tasks', 'outcome', 'task outcomes are never null');
select has_column('public', 'tasks', 'acceptance_criteria', 'tasks store durable acceptance criteria');
select col_not_null('public', 'tasks', 'acceptance_criteria', 'task acceptance criteria are never null');

insert into auth.users (id, email) values ('81000000-0000-4000-8000-000000000081', 'metrics@example.test');
insert into public.tasks (id, user_id, key, title, state)
values ('82000000-0000-4000-8000-000000000082', '81000000-0000-4000-8000-000000000081', 'METRIC-1', 'Metric task', 'planning');
insert into public.jobs (id, user_id, task_id, kind, step_id, status, payload)
values ('83000000-0000-4000-8000-000000000083', '81000000-0000-4000-8000-000000000081', '82000000-0000-4000-8000-000000000082', 'agent', 'planning', 'queued', '{"kind":"agent"}'::jsonb);
select is(public.sindral_operational_snapshot()->'taskStates'->>'planning', '1', 'snapshot aggregates task states');
select is(public.sindral_operational_snapshot()->'jobStatuses'->>'queued', '1', 'snapshot aggregates job statuses');

select * from finish();
rollback;
