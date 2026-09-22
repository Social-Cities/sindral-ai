alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check
  check (status in ('queued', 'claimed', 'running', 'applying', 'completed', 'failed', 'cancelled'));
alter table public.jobs
  add column outcome_hash text check (outcome_hash is null or outcome_hash ~ '^[0-9a-f]{64}$'),
  add column outcome_token uuid,
  add column outcome_started_at timestamptz,
  add column dedupe_key text;
create unique index jobs_dedupe_idx on public.jobs(user_id, dedupe_key);

alter table public.task_events add column dedupe_key text;
create unique index task_events_dedupe_idx on public.task_events(task_id, dedupe_key);
alter table public.task_artifacts add column dedupe_key text;
create unique index task_artifacts_dedupe_idx on public.task_artifacts(task_id, dedupe_key);

create or replace function public.begin_job_outcome(
  p_user_id uuid,
  p_job_id uuid,
  p_attempt integer,
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
  if v_job.attempt <> p_attempt then
    raise exception using errcode = '40001', message = format('Job attempt %s has been superseded', p_attempt);
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

create or replace function public.finalize_job_outcome(
  p_user_id uuid,
  p_job_id uuid,
  p_attempt integer,
  p_outcome_hash text,
  p_token uuid,
  p_status text
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.jobs%rowtype;
begin
  if p_status not in ('completed', 'failed') then
    raise exception using errcode = '22023', message = 'Invalid final job status';
  end if;
  update public.jobs
  set status = p_status, finished_at = now(), outcome_token = null
  where id = p_job_id
    and user_id = p_user_id
    and attempt = p_attempt
    and status = 'applying'
    and outcome_hash = p_outcome_hash
    and outcome_token = p_token
  returning * into v_job;
  if found then return v_job; end if;

  select * into v_job from public.jobs where id = p_job_id and user_id = p_user_id;
  if found and v_job.attempt = p_attempt and v_job.outcome_hash = p_outcome_hash and v_job.status = p_status then
    return v_job;
  end if;
  raise exception using errcode = '40001', message = 'Job outcome lease was superseded';
end
$$;

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
  set status = 'running', outcome_token = null, outcome_started_at = null
  where id = p_job_id
    and user_id = p_user_id
    and attempt = p_attempt
    and status = 'applying'
    and outcome_hash = p_outcome_hash
    and outcome_token = p_token;
$$;

-- Keep later work for a task blocked while a durable outcome is being applied.
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
  ),
  picked as (
    select e.id from eligible e
    where e.rn = 1
    order by e.created_at, e.id
    limit greatest(1, least(coalesce(p_max, 1), 10))
  ),
  locked as (
    select j.id from public.jobs j
    where j.id in (select id from picked) and j.status = 'queued'
    order by j.id
    for update skip locked
  )
  update public.jobs j
  set status = 'claimed', worker_id = p_worker_id, claimed_at = now()
  from locked l
  where j.id = l.id
  returning j.*;
end
$$;

revoke all on function public.begin_job_outcome(uuid, uuid, integer, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.finalize_job_outcome(uuid, uuid, integer, text, uuid, text) from public, anon, authenticated;
revoke all on function public.abandon_job_outcome(uuid, uuid, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_jobs(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.begin_job_outcome(uuid, uuid, integer, text, jsonb, text) to service_role;
grant execute on function public.finalize_job_outcome(uuid, uuid, integer, text, uuid, text) to service_role;
grant execute on function public.abandon_job_outcome(uuid, uuid, integer, text, uuid) to service_role;
grant execute on function public.claim_jobs(uuid, uuid, integer) to service_role;
