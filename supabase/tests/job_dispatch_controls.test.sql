begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, email)
values ('71000000-0000-4000-8000-000000000071', 'dispatch-owner@example.test');
insert into public.tasks (id, user_id, key, title, state)
values
  ('72000000-0000-4000-8000-000000000072', '71000000-0000-4000-8000-000000000071', 'DISPATCH-1', 'Agent task', 'planning'),
  ('73000000-0000-4000-8000-000000000073', '71000000-0000-4000-8000-000000000071', 'DISPATCH-2', 'Merge task', 'merge');
insert into public.workers (id, user_id, name, hostname, version)
values ('74000000-0000-4000-8000-000000000074', '71000000-0000-4000-8000-000000000071', 'worker', 'host', '1');
insert into public.jobs (id, user_id, task_id, kind, step_id, payload)
values
  ('75000000-0000-4000-8000-000000000075', '71000000-0000-4000-8000-000000000071', '72000000-0000-4000-8000-000000000072', 'agent', 'planning', '{"kind":"agent"}'::jsonb),
  ('76000000-0000-4000-8000-000000000076', '71000000-0000-4000-8000-000000000071', '73000000-0000-4000-8000-000000000073', 'merge-pull-requests', 'merge', '{"kind":"merge-pull-requests","pullRequests":[]}'::jsonb);

create temporary table filtered_claim as
select * from public.claim_jobs(
  '71000000-0000-4000-8000-000000000071',
  '74000000-0000-4000-8000-000000000074',
  10,
  array['agent', 'rebase-stack', 'resolve-rebase-conflict']
);

select is((select count(*) from filtered_claim), 1::bigint, 'filtered claims still dispatch allowed work');
select is((select kind from filtered_claim), 'agent', 'filtered claims exclude merge jobs');
select is((select status from public.jobs where id = '76000000-0000-4000-8000-000000000076'), 'queued', 'excluded merge remains queued and unleased');

update public.jobs set status = 'completed', finished_at = now()
where id = '75000000-0000-4000-8000-000000000075';
select is(
  (select kind from public.claim_jobs(
    '71000000-0000-4000-8000-000000000071',
    '74000000-0000-4000-8000-000000000074',
    1,
    null
  )),
  'merge-pull-requests',
  'unrestricted claims can lease the queued merge job'
);

select ok(
  not has_function_privilege('authenticated', 'public.claim_jobs(uuid,uuid,integer,text[])', 'EXECUTE'),
  'browser role cannot invoke the filtered claim function'
);

select * from finish();
rollback;
