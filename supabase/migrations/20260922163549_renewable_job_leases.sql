alter table public.jobs
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add constraint jobs_lease_pair check ((lease_token is null) = (lease_expires_at is null));

-- Give in-flight jobs from the previous release a bounded compatibility lease.
-- Applying outcomes can be resumed server-side; claimed/running jobs are fenced
-- and will be requeued if their pre-token worker cannot finish in this window.
update public.jobs
set lease_token = gen_random_uuid(), lease_expires_at = now() + interval '90 seconds'
where status in ('claimed', 'running', 'applying');

create index jobs_active_lease_idx
  on public.jobs(lease_expires_at)
  where status in ('claimed', 'running');

-- Replace the old completion entry point so an attempt number alone is no
-- longer a capability. Terminal replays accept an expired matching token;
-- active outcomes require an unexpired lease.
drop function public.begin_job_outcome(uuid, uuid, integer, text, jsonb, text);
create function public.begin_job_outcome(
  p_user_id uuid,
  p_job_id uuid,
  p_attempt integer,
  p_lease_token uuid,
  p_outcome_hash text,
  p_result jsonb default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_token uuid;
begin
  if p_outcome_hash !~ '^[0-9a-f]{64}$' or (p_result is null) = (p_error is null) then
    raise exception using errcode = '22023', message = 'Exactly one valid job result or error is required';
  end if;

  select * into v_job from public.jobs
  where id = p_job_id and user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Job does not exist or is not owned by this user';
  end if;
  if v_job.attempt <> p_attempt or v_job.lease_token is distinct from p_lease_token then
    raise exception using errcode = '40001', message = 'Job lease has been superseded';
  end if;
  if v_job.outcome_hash is not null and v_job.outcome_hash <> p_outcome_hash then
    raise exception using errcode = '22023', message = 'Job outcome does not match the accepted outcome';
  end if;
  if v_job.status in ('completed', 'failed') then
    return jsonb_build_object('state', 'replay', 'token', null, 'job', to_jsonb(v_job));
  end if;
  if v_job.status = 'applying' and v_job.outcome_started_at > now() - interval '30 seconds' then
    return jsonb_build_object('state', 'busy', 'token', null, 'job', to_jsonb(v_job));
  end if;
  if v_job.status not in ('claimed', 'running', 'applying') then
    raise exception using errcode = '40001', message = format('Job is %s', v_job.status);
  end if;
  if v_job.status <> 'applying' and (v_job.lease_expires_at is null or v_job.lease_expires_at <= now()) then
    raise exception using errcode = '40001', message = 'Job lease has expired';
  end if;

  v_token := gen_random_uuid();
  update public.jobs
  set status = 'applying',
      outcome_hash = p_outcome_hash,
      outcome_token = v_token,
      outcome_started_at = now(),
      result = p_result,
      error = p_error
  where id = p_job_id and user_id = p_user_id
  returning * into v_job;
  return jsonb_build_object('state', 'acquired', 'token', v_token, 'job', to_jsonb(v_job));
end
$$;

-- Heartbeats renew only capabilities owned by this worker and only before
-- expiry. A late heartbeat cannot resurrect a lease already eligible to sweep.
create function public.renew_job_leases(p_user_id uuid, p_worker_id uuid, p_leases jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  with requested as (
    select (item->>'jobId')::uuid as job_id, (item->>'leaseToken')::uuid as lease_token
    from jsonb_array_elements(coalesce(p_leases, '[]'::jsonb)) item
  ), renewed as (
    update public.jobs j
    set lease_expires_at = now() + interval '90 seconds'
    from requested r
    where j.id = r.job_id
      and j.user_id = p_user_id
      and j.worker_id = p_worker_id
      and j.lease_token = r.lease_token
      and j.lease_expires_at > now()
      and j.status in ('claimed', 'running')
    returning j.id
  )
  select count(*)::integer into v_count from renewed;
  return v_count;
end
$$;

-- Validate the capability and mark first activity atomically. This prevents a
-- sweeper from requeueing between an application-side check and a status write.
create function public.activate_job_lease(p_user_id uuid, p_job_id uuid, p_attempt integer, p_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_activated boolean;
begin
  update public.jobs
  set status = 'running'
  where id = p_job_id
    and user_id = p_user_id
    and attempt = p_attempt
    and lease_token = p_lease_token
    and lease_expires_at > now()
    and status in ('claimed', 'running')
  returning true into v_activated;
  return coalesce(v_activated, false);
end
$$;

create or replace function public.claim_jobs(p_user_id uuid, p_worker_id uuid, p_max integer)
returns setof public.jobs language plpgsql security definer set search_path = '' as $$
begin
  return query
  with eligible as (
    select j.id, j.task_id, j.created_at,
           row_number() over (partition by j.task_id order by j.created_at, j.id) as rn
    from public.jobs j
    where j.user_id = p_user_id
      and j.status = 'queued'
      and not exists (
        select 1 from public.jobs o
        where o.task_id = j.task_id and o.status in ('claimed', 'running', 'applying')
      )
  ), picked as (
    select e.id from eligible e
    where e.rn = 1
    order by e.created_at, e.id
    limit greatest(1, least(coalesce(p_max, 1), 10))
  ), locked as (
    select j.id from public.jobs j
    where j.id in (select id from picked) and j.status = 'queued'
    order by j.id
    for update skip locked
  )
  update public.jobs j
  set status = 'claimed',
      worker_id = p_worker_id,
      claimed_at = now(),
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '90 seconds'
  from locked l
  where j.id = l.id
  returning j.*;
end
$$;

-- Give a worker a short retry window when server-side outcome application
-- fails after its outcome was durably recorded.
create or replace function public.abandon_job_outcome(
  p_user_id uuid,
  p_job_id uuid,
  p_attempt integer,
  p_outcome_hash text,
  p_token uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.jobs
  set status = 'running', outcome_token = null, outcome_started_at = null,
      lease_expires_at = now() + interval '90 seconds'
  where id = p_job_id
    and user_id = p_user_id
    and attempt = p_attempt
    and status = 'applying'
    and outcome_hash = p_outcome_hash
    and outcome_token = p_token;
$$;

revoke all on function public.begin_job_outcome(uuid, uuid, integer, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.renew_job_leases(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.activate_job_lease(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.begin_job_outcome(uuid, uuid, integer, uuid, text, jsonb, text) to service_role;
grant execute on function public.renew_job_leases(uuid, uuid, jsonb) to service_role;
grant execute on function public.activate_job_lease(uuid, uuid, integer, uuid) to service_role;

-- The browser role may read owned job state through RLS, but worker and
-- outcome capabilities must remain server-only even when PostgREST is queried
-- directly with select=*.
revoke select on public.jobs from authenticated;
grant select (
  id, user_id, task_id, kind, step_id, status, worker_id, attempt, payload,
  result, error, created_at, claimed_at, lease_expires_at, finished_at,
  outcome_hash, outcome_started_at, dedupe_key
) on public.jobs to authenticated;
