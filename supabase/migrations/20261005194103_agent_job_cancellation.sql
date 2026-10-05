alter table public.jobs
  add column if not exists cancel_requested_at timestamptz;

create index if not exists jobs_cancel_requested_idx
  on public.jobs(cancel_requested_at)
  where cancel_requested_at is not null and status in ('claimed', 'running');

drop function if exists public.begin_job_outcome(uuid, uuid, integer, uuid, text, jsonb, text);

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
  if v_job.cancel_requested_at is not null then
    update public.jobs
    set status = 'cancelled',
        finished_at = now(),
        lease_token = null,
        lease_expires_at = null
    where id = p_job_id and user_id = p_user_id
    returning * into v_job;
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

revoke all on function public.begin_job_outcome(uuid, uuid, integer, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.begin_job_outcome(uuid, uuid, integer, uuid, text, jsonb, text) to service_role;

create or replace function public.acknowledge_job_cancellation(
  p_user_id uuid,
  p_job_id uuid,
  p_attempt integer,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean;
begin
  update public.jobs
  set status = 'cancelled',
      finished_at = now(),
      lease_token = null,
      lease_expires_at = null
  where user_id = p_user_id
    and id = p_job_id
    and attempt = p_attempt
    and lease_token = p_lease_token
    and cancel_requested_at is not null
    and status in ('claimed', 'running')
  returning true into v_updated;

  return coalesce(v_updated, false);
end
$$;

revoke all on function public.acknowledge_job_cancellation(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.acknowledge_job_cancellation(uuid, uuid, integer, uuid) to service_role;

create or replace function public.sindral_schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select '20261005194103'::text $$;

revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
