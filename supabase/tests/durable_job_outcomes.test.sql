begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email)
values
  ('30000000-0000-4000-8000-000000000003', 'outcome-a@example.test'),
  ('40000000-0000-4000-8000-000000000004', 'outcome-b@example.test');
insert into public.tasks (id, user_id, key, title, state)
values ('c0000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'OUTCOME-1', 'Outcome task', 'planning');
insert into public.workers (id, user_id, name, hostname, version)
values ('50000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000003', 'worker', 'host', '1');
insert into public.jobs (id, user_id, task_id, kind, step_id, status, worker_id, payload, claimed_at, lease_token, lease_expires_at)
values (
  '60000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000003',
  'c0000000-0000-4000-8000-000000000003',
  'agent', 'planning', 'claimed', '50000000-0000-4000-8000-000000000005',
  '{"kind":"agent"}'::jsonb, now(), '80000000-0000-4000-8000-000000000008', now() + interval '90 seconds'
);

create temporary table outcome_claim as
select public.begin_job_outcome(
  '30000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000006',
  1,
  '80000000-0000-4000-8000-000000000008',
  repeat('a', 64),
  '{"kind":"plan","summary":"done","plan":"# Plan"}'::jsonb,
  null
) as value;

select is((select value->>'state' from outcome_claim), 'acquired', 'first outcome request acquires the processing lease');
select is((select status from public.jobs where id = '60000000-0000-4000-8000-000000000006'), 'applying', 'job remains non-terminal while effects apply');
select is((select result->>'kind' from public.jobs where id = '60000000-0000-4000-8000-000000000006'), 'plan', 'accepted result is durable before orchestration');
insert into public.jobs (id, user_id, task_id, kind, step_id, status, payload)
values (
  '70000000-0000-4000-8000-000000000007',
  '30000000-0000-4000-8000-000000000003',
  'c0000000-0000-4000-8000-000000000003',
  'agent', 'implementation', 'queued', '{"kind":"agent"}'::jsonb
);
select is(
  (select count(*) from public.claim_jobs(
    '30000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000005',
    1
  )),
  0::bigint,
  'an applying outcome blocks later work for the same task'
);
select is(
  public.begin_job_outcome(
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006', 1,
    '80000000-0000-4000-8000-000000000008',
    repeat('a', 64), '{"kind":"plan"}'::jsonb, null
  )->>'state',
  'busy',
  'concurrent duplicate cannot process effects twice'
);
select throws_ok(
  $$select public.begin_job_outcome(
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006', 1,
    '80000000-0000-4000-8000-000000000008',
    repeat('b', 64), '{"kind":"plan"}'::jsonb, null
  )$$,
  '22023', 'Job outcome does not match the accepted outcome', 'different outcome is rejected'
);
select is(
  (public.finalize_job_outcome(
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006', 1,
    repeat('a', 64), (select (value->>'token')::uuid from outcome_claim), 'completed'
  )).status,
  'completed',
  'lease owner finalizes the job'
);
select is(
  public.begin_job_outcome(
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006', 1,
    '80000000-0000-4000-8000-000000000008',
    repeat('a', 64), '{"kind":"plan"}'::jsonb, null
  )->>'state',
  'replay',
  'completed identical outcome replays'
);
select throws_ok(
  $$select public.begin_job_outcome(
    '40000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000006', 1,
    '80000000-0000-4000-8000-000000000008',
    repeat('a', 64), '{"kind":"plan"}'::jsonb, null
  )$$,
  '42501', 'Job does not exist or is not owned by this user', 'cross-tenant outcome is rejected'
);

insert into public.task_events (task_id, user_id, type, dedupe_key)
values ('c0000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'once', 'effect:event')
on conflict (task_id, dedupe_key) do nothing;
insert into public.task_events (task_id, user_id, type, dedupe_key)
values ('c0000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'once', 'effect:event')
on conflict (task_id, dedupe_key) do nothing;
select is((select count(*) from public.task_events where dedupe_key = 'effect:event'), 1::bigint, 'event effects deduplicate');

select ok(not has_function_privilege('authenticated', 'public.begin_job_outcome(uuid,uuid,integer,uuid,text,jsonb,text)', 'EXECUTE'), 'browser role cannot begin outcomes');
select ok(has_function_privilege('service_role', 'public.begin_job_outcome(uuid,uuid,integer,uuid,text,jsonb,text)', 'EXECUTE'), 'service role can begin outcomes');
select ok(not has_function_privilege('authenticated', 'public.finalize_job_outcome(uuid,uuid,integer,text,uuid,text)', 'EXECUTE'), 'browser role cannot finalize outcomes');
select ok(has_function_privilege('service_role', 'public.finalize_job_outcome(uuid,uuid,integer,text,uuid,text)', 'EXECUTE'), 'service role can finalize outcomes');

select * from finish();
rollback;
