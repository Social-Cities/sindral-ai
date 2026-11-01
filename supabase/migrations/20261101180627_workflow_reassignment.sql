-- Atomically move a ticket, pin the selected workflow, cancel old queued work and dispatch the selected step.
create or replace function public.reassign_task_workflow(
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
  p_cancel_queued boolean default false,
  p_workflow_id uuid default null,
  p_platforms text[] default null
)
returns jsonb
language plpgsql
security invoker
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

  if v_task.state in ('done', 'wont-do') then
    raise exception using errcode = '40001', message = 'Reopen the task before changing its workflow';
  end if;
  perform 1 from public.workflows where id = p_workflow_id and user_id = p_user_id for share;
  if not found then
    raise exception using errcode = '42501', message = 'Workflow does not exist or is not owned by this user';
  end if;
  if not p_cancel_queued or not p_pin_workflow or p_pinned_workflow->>'id' is distinct from p_workflow_id::text
    or not exists (select 1 from jsonb_array_elements(p_pinned_workflow->'steps') step
      where step->>'id' = p_next_step_id and step->>'type' in ('human', 'agent') and step->>'state' = p_next_state)
    or p_event->>'type' is distinct from 'workflow-reassigned' then
    raise exception using errcode = '22023', message = 'Invalid workflow assignment';
  end if;

  -- Serialize with job claims and outcomes for this ticket and parent maintenance.
  perform 1 from public.jobs
  where user_id = p_user_id
    and (task_id = p_task_id or (v_task.parent_task_id is not null and task_id = v_task.parent_task_id))
  for update;
  if exists (
    select 1 from public.jobs where user_id = p_user_id
      and (task_id = p_task_id or (v_task.parent_task_id is not null and task_id = v_task.parent_task_id))
      and status in ('claimed', 'running', 'applying')
  ) then
    raise exception using errcode = '40001', message = 'Task has active work; wait for it to finish before changing the workflow';
  end if;

  update public.tasks
  set workflow_id = p_workflow_id,
      platforms = p_platforms,
      last_error = null,
      state = p_next_state,
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

  update public.jobs
    set status = 'cancelled', finished_at = now()
    where user_id = p_user_id and task_id = p_task_id and status = 'queued';

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

revoke all on function public.reassign_task_workflow(uuid, uuid, bigint, text, text, text, text, text, boolean, jsonb, jsonb, jsonb, boolean, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.reassign_task_workflow(uuid, uuid, bigint, text, text, text, text, text, boolean, jsonb, jsonb, jsonb, boolean, uuid, text[])
  to service_role;

create or replace function public.sindral_schema_version() returns text
language sql stable security invoker set search_path = ''
as $$ select '20261101180627'::text $$;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
