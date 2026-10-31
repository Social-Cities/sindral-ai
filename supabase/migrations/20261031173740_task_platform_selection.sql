-- Per-task platform scope; existing non-mobile tasks retain null.
alter table public.tasks add column platforms text[];
alter table public.tasks add constraint tasks_platforms_check check (
  platforms is null or (
    cardinality(platforms) between 1 and 3
    and platforms <@ array['ios', 'android', 'web']::text[]
    and array_position(platforms, null) is null
    and cardinality(platforms) = (case when 'ios' = any(platforms) then 1 else 0 end
      + case when 'android' = any(platforms) then 1 else 0 end
      + case when 'web' = any(platforms) then 1 else 0 end)
  )
);

-- Preserve running task scope and snapshot defaults for pending mobile tasks.
update public.tasks t set platforms = array(select jsonb_array_elements_text(coalesce(
  t.pinned_workflow->'mobilePlatforms',
  (select to_jsonb(p.platforms) from public.projects p where p.id = t.project_id and p.user_id = t.user_id and p.project_type = 'mobile-app'),
  (select w.definition->'mobilePlatforms' from public.workflows w where w.id = t.workflow_id and w.user_id = t.user_id)
)))
where coalesce(t.pinned_workflow,
  (select w.definition from public.workflows w where w.id = t.workflow_id and w.user_id = t.user_id)) ? 'mobilePlatforms';

-- Clarify optional task-level clients without replacing edited workflow definitions.
update public.workflows set definition = jsonb_set(definition, '{description}', to_jsonb('BDD tests → review both plans → task-selected clients in iOS → Android → Web order → review → verify → ready for release.'::text))
where definition ? 'mobilePlatforms'
  and definition->>'description' = 'BDD tests → implementation plan → review both plans → iOS → Android → Web → review → verify BDD → ready for release.';

-- Design handoffs must persist the same selected scope atomically with task creation.
create or replace function public.create_design_implementation_task(p_user_id uuid, p_task jsonb, p_revision_id uuid, p_idempotency_key uuid, p_request_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_handoff public.design_handoffs%rowtype; v_revision public.design_revisions%rowtype; v_task public.tasks%rowtype;
begin
  -- The advisory lock serializes retries even before a target task exists.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0));
  select * into v_handoff from public.design_handoffs where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_handoff.request_hash <> p_request_hash then raise exception using errcode = '23505', message = 'Handoff request key was reused with different input'; end if;
    select * into v_task from public.tasks where id = v_handoff.task_id and user_id = p_user_id;
    return to_jsonb(v_task);
  end if;
  select * into v_revision from public.design_revisions where id = p_revision_id and user_id = p_user_id for share;
  if not found or v_revision.approved_at is null then raise exception using errcode = '23505', message = 'Approve this design revision before creating an implementation task'; end if;
  if nullif(p_task->>'workflowId', '') is not null and not exists(select 1 from public.workflows where id = (p_task->>'workflowId')::uuid and user_id = p_user_id) then raise exception 'Unknown workflow'; end if;
  if nullif(p_task->>'projectId', '') is not null and not exists(select 1 from public.projects where id = (p_task->>'projectId')::uuid and user_id = p_user_id) then raise exception 'Unknown project'; end if;
  insert into public.tasks(user_id, key, title, description, project_id, outcome, acceptance_criteria, state, workflow_id, repos, branch, platforms)
    values(p_user_id, p_task->>'key', p_task->>'title', coalesce(p_task->>'description', ''), (p_task->>'projectId')::uuid,
      coalesce(p_task->>'outcome', ''), coalesce(p_task->>'acceptanceCriteria', ''), 'todo', (p_task->>'workflowId')::uuid,
      array(select jsonb_array_elements_text(p_task->'repos')), p_task->>'branch', case when jsonb_typeof(p_task->'platforms') = 'array' then array(select jsonb_array_elements_text(p_task->'platforms')) else null end) returning * into v_task;
  insert into public.design_handoffs(task_id, user_id, idempotency_key, request_hash, snapshot)
    values(v_task.id, p_user_id, p_idempotency_key, p_request_hash, jsonb_build_object(
      'sourceTaskId', v_revision.task_id, 'revisionId', v_revision.id, 'approvedAt', v_revision.approved_at, 'result', v_revision.result));
  return to_jsonb(v_task);
end $$;

create or replace function public.sindral_schema_version() returns text
language sql stable security invoker set search_path = ''
as $$ select '20261031173740'::text $$;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
