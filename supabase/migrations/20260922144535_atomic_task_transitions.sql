-- Durable optimistic concurrency and request replay for workflow transitions.
alter table public.tasks add column version bigint not null default 0 check (version >= 0);

create table public.idempotency_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  operation text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  task_id uuid references public.tasks(id) on delete cascade,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);
create index idempotency_keys_created_idx on public.idempotency_keys(created_at);

alter table public.idempotency_keys enable row level security;
revoke all on public.idempotency_keys from public, anon, authenticated;
grant select, insert, update, delete on public.idempotency_keys to service_role;

create or replace function public.apply_task_transition(
  p_user_id uuid,
  p_task_id uuid,
  p_expected_version bigint,
  p_idempotency_key text,
  p_request_hash text,
  p_next_state text,
  p_next_step_id text,
  p_failed_step_id text,
  p_pin_workflow boolean,
  p_pinned_workflow jsonb,
  p_event jsonb,
  p_job jsonb default null,
  p_cancel_queued boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted boolean;
  v_ledger public.idempotency_keys%rowtype;
  v_task public.tasks%rowtype;
  v_job public.jobs%rowtype;
  v_response jsonb;
begin
  if p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception using errcode = '22023', message = 'Invalid idempotency key';
  end if;
  if p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid request hash';
  end if;

  insert into public.idempotency_keys (user_id, idempotency_key, operation, request_hash, task_id)
  values (p_user_id, p_idempotency_key, 'task-transition', p_request_hash, p_task_id)
  on conflict (user_id, idempotency_key) do nothing
  returning true into v_inserted;

  if coalesce(v_inserted, false) = false then
    select * into v_ledger
    from public.idempotency_keys
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_ledger.operation <> 'task-transition' or v_ledger.request_hash <> p_request_hash then
      raise exception using errcode = '22023', message = 'Idempotency key was already used for a different request';
    end if;
    if v_ledger.response is null then
      raise exception using errcode = '40001', message = 'Idempotent command is still in progress';
    end if;
    return jsonb_set(v_ledger.response, '{replayed}', 'true'::jsonb, true);
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Task does not exist or is not owned by this user';
  end if;
  if v_task.version <> p_expected_version then
    raise exception using errcode = '40001',
      message = format('Task version %s is stale; current version is %s', p_expected_version, v_task.version);
  end if;

  update public.tasks
  set state = p_next_state,
      current_step_id = p_next_step_id,
      failed_step_id = p_failed_step_id,
      pinned_workflow = case when p_pin_workflow then p_pinned_workflow else pinned_workflow end,
      version = version + 1
  where id = p_task_id and user_id = p_user_id
  returning * into v_task;

  insert into public.task_events (task_id, user_id, type, from_state, to_state, step_id, detail)
  values (
    p_task_id,
    p_user_id,
    p_event->>'type',
    p_event->>'fromState',
    p_event->>'toState',
    p_event->>'stepId',
    p_event->'detail'
  );

  if p_cancel_queued then
    update public.jobs
    set status = 'cancelled', finished_at = now()
    where user_id = p_user_id and task_id = p_task_id and status = 'queued';
  end if;

  if p_job is not null then
    insert into public.jobs (user_id, task_id, kind, step_id, payload)
    values (p_user_id, p_task_id, p_job->>'kind', p_job->>'stepId', p_job->'payload')
    returning * into v_job;

    insert into public.task_events (task_id, user_id, type, step_id, detail)
    values (
      p_task_id,
      p_user_id,
      'job-queued',
      v_job.step_id,
      jsonb_build_object('jobId', v_job.id, 'kind', v_job.kind)
    );
  end if;

  v_response := jsonb_build_object(
    'task', to_jsonb(v_task),
    'job', case when v_job.id is null then 'null'::jsonb else to_jsonb(v_job) end,
    'replayed', false
  );
  update public.idempotency_keys
  set response = v_response
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  return v_response;
end
$$;

revoke all on function public.apply_task_transition(uuid, uuid, bigint, text, text, text, text, text, boolean, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.apply_task_transition(uuid, uuid, bigint, text, text, text, text, text, boolean, jsonb, jsonb, jsonb, boolean)
  to service_role;

-- Be explicit for new Supabase projects where Data API grants are no longer
-- added automatically. RLS still limits authenticated reads to the owner.
grant select on
  public.profiles, public.workers, public.workflows, public.tasks,
  public.task_messages, public.task_events, public.task_artifacts, public.jobs,
  public.job_logs, public.task_repositories, public.pull_requests
  to authenticated;
grant update on public.profiles to authenticated;

-- The API's service-role client is the only writer for application tables.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
