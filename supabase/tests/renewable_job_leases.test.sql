begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email)
values ('61000000-0000-4000-8000-000000000061', 'lease-owner@example.test');
insert into public.tasks (id, user_id, key, title, state)
values ('62000000-0000-4000-8000-000000000062', '61000000-0000-4000-8000-000000000061', 'LEASE-1', 'Lease task', 'planning');
insert into public.workers (id, user_id, name, hostname, version)
values ('63000000-0000-4000-8000-000000000063', '61000000-0000-4000-8000-000000000061', 'worker', 'host', '1');
insert into public.jobs (id, user_id, task_id, kind, step_id, payload)
values ('64000000-0000-4000-8000-000000000064', '61000000-0000-4000-8000-000000000061', '62000000-0000-4000-8000-000000000062', 'agent', 'planning', '{"kind":"agent"}'::jsonb);

create temporary table first_claim as
select * from public.claim_jobs(
  '61000000-0000-4000-8000-000000000061',
  '63000000-0000-4000-8000-000000000063',
  1
);

select isnt((select lease_token from first_claim), null::uuid, 'claim mints a lease token');
select ok((select lease_expires_at > now() from first_claim), 'claim expiry is in the future');
select is(
  public.activate_job_lease(
    '61000000-0000-4000-8000-000000000061', '64000000-0000-4000-8000-000000000064', 1,
    (select lease_token from first_claim)
  ),
  true,
  'the exact capability atomically marks a claimed job running'
);
select is(
  public.renew_job_leases(
    '61000000-0000-4000-8000-000000000061', '63000000-0000-4000-8000-000000000063',
    '[{"jobId":"64000000-0000-4000-8000-000000000064","leaseToken":"65000000-0000-4000-8000-000000000065"}]'::jsonb
  ),
  0,
  'a wrong token cannot renew the lease'
);
select is(
  public.renew_job_leases(
    '61000000-0000-4000-8000-000000000061', '63000000-0000-4000-8000-000000000063',
    jsonb_build_array(jsonb_build_object('jobId', id, 'leaseToken', lease_token))
  ),
  1,
  'the owning worker and token renew the lease'
)
from first_claim;

update public.jobs set lease_expires_at = now() - interval '1 second'
where id = '64000000-0000-4000-8000-000000000064';
select is(
  public.renew_job_leases(
    '61000000-0000-4000-8000-000000000061', '63000000-0000-4000-8000-000000000063',
    jsonb_build_array(jsonb_build_object('jobId', id, 'leaseToken', lease_token))
  ),
  0,
  'an expired lease cannot be resurrected'
)
from first_claim;
select throws_ok(
  $$select public.begin_job_outcome(
    '61000000-0000-4000-8000-000000000061', '64000000-0000-4000-8000-000000000064', 1,
    (select lease_token from first_claim), repeat('a', 64), '{"kind":"plan"}'::jsonb, null
  )$$,
  '40001', 'Job lease has expired', 'an expired attempt cannot submit an outcome'
);

update public.jobs
set status = 'queued', worker_id = null, claimed_at = null, lease_token = null, lease_expires_at = null, attempt = 2
where id = '64000000-0000-4000-8000-000000000064';
create temporary table second_claim as
select * from public.claim_jobs(
  '61000000-0000-4000-8000-000000000061',
  '63000000-0000-4000-8000-000000000063',
  1
);
select isnt((select lease_token from second_claim), (select lease_token from first_claim), 'a reclaimed attempt gets a fresh token');
select throws_ok(
  $$select public.begin_job_outcome(
    '61000000-0000-4000-8000-000000000061', '64000000-0000-4000-8000-000000000064', 2,
    (select lease_token from first_claim), repeat('b', 64), '{"kind":"plan"}'::jsonb, null
  )$$,
  '40001', 'Job lease has been superseded', 'the previous token cannot complete the reclaimed attempt'
);
select ok(not has_function_privilege('authenticated', 'public.renew_job_leases(uuid,uuid,jsonb)', 'EXECUTE'), 'browser role cannot renew job leases');
select ok(not has_function_privilege('authenticated', 'public.activate_job_lease(uuid,uuid,integer,uuid)', 'EXECUTE'), 'browser role cannot activate job leases');
select ok(not has_column_privilege('authenticated', 'public.jobs', 'lease_token', 'SELECT'), 'browser role cannot read worker lease capabilities');
select ok(not has_column_privilege('authenticated', 'public.jobs', 'outcome_token', 'SELECT'), 'browser role cannot read outcome capabilities');

select * from finish();
rollback;
