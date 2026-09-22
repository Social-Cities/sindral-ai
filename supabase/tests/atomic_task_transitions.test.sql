begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'atomic-a@example.test'),
  ('20000000-0000-4000-8000-000000000002', 'atomic-b@example.test');

insert into public.tasks (id, user_id, key, title, state)
values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ATOMIC-1', 'Owner A task', 'todo'),
  ('b0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'ATOMIC-2', 'Owner B task', 'todo');

select is(
  public.apply_task_transition(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    0,
    'atomic-command-0001',
    repeat('a', 64),
    'planning',
    'planning',
    null,
    false,
    null,
    jsonb_build_object('type', 'transition', 'fromState', 'todo', 'toState', 'planning', 'stepId', 'planning', 'detail', jsonb_build_object('event', 'start')),
    jsonb_build_object('kind', 'agent', 'stepId', 'planning', 'payload', jsonb_build_object('kind', 'agent')),
    false
  )->'task'->>'state',
  'planning',
  'applies the requested transition'
);
select is((select version from public.tasks where id = 'a0000000-0000-4000-8000-000000000001'), 1::bigint, 'increments the task version');
select is((select count(*) from public.jobs where task_id = 'a0000000-0000-4000-8000-000000000001'), 1::bigint, 'queues exactly one job');
select is((select count(*) from public.task_events where task_id = 'a0000000-0000-4000-8000-000000000001' and type = 'transition'), 1::bigint, 'writes one transition event');
select is((select count(*) from public.task_events where task_id = 'a0000000-0000-4000-8000-000000000001' and type = 'job-queued'), 1::bigint, 'writes one job event');

select is(
  public.apply_task_transition(
    '10000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    0,
    'atomic-command-0001',
    repeat('a', 64),
    'ignored-on-replay', null, null, false, null,
    '{}'::jsonb, null, false
  )->>'replayed',
  'true',
  'replays the stored response before checking stale state'
);
select is((select count(*) from public.jobs where task_id = 'a0000000-0000-4000-8000-000000000001'), 1::bigint, 'replay does not duplicate jobs');
select is((select count(*) from public.task_events where task_id = 'a0000000-0000-4000-8000-000000000001'), 2::bigint, 'replay does not duplicate events');

select throws_ok(
  $$select public.apply_task_transition(
    '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 0,
    'atomic-command-0002', repeat('b', 64), 'verify', 'verify', null, false, null,
    '{}'::jsonb, null, false
  )$$,
  '40001',
  'Task version 0 is stale; current version is 1',
  'rejects a distinct command with a stale version'
);
select throws_ok(
  $$select public.apply_task_transition(
    '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 0,
    'atomic-command-0001', repeat('c', 64), 'verify', 'verify', null, false, null,
    '{}'::jsonb, null, false
  )$$,
  '22023',
  'Idempotency key was already used for a different request',
  'rejects reuse of a key for different input'
);
select throws_ok(
  $$select public.apply_task_transition(
    '20000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 1,
    'atomic-command-0003', repeat('d', 64), 'verify', 'verify', null, false, null,
    '{}'::jsonb, null, false
  )$$,
  '42501',
  'Task does not exist or is not owned by this user',
  'rejects a cross-tenant command'
);

select ok(not has_function_privilege('authenticated', 'public.apply_task_transition(uuid,uuid,bigint,text,text,text,text,text,boolean,jsonb,jsonb,jsonb,boolean)', 'EXECUTE'), 'browser role cannot execute transition RPC');
select ok(has_function_privilege('service_role', 'public.apply_task_transition(uuid,uuid,bigint,text,text,text,text,text,boolean,jsonb,jsonb,jsonb,boolean)', 'EXECUTE'), 'service role can execute transition RPC');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select results_eq(
  $$select key from public.tasks order by key$$,
  $$values ('ATOMIC-1'::text)$$,
  'RLS exposes only the authenticated owner task'
);

select * from finish();
rollback;
