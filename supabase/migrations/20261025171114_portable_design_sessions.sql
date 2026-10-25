-- Transcripts are private worker state. Browser access always goes through the owner-scoped API.
create table public.design_sessions (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid,
  files jsonb not null default '[]'::jsonb check (jsonb_typeof(files) = 'array' and octet_length(files::text) <= 3800000),
  updated_at timestamptz not null default now()
);
create index design_sessions_user_idx on public.design_sessions(user_id);

create table public.design_session_entries (
  seq bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_key text not null,
  session_id uuid not null,
  subpath text not null default '',
  entry_key text not null,
  entry jsonb not null check (jsonb_typeof(entry) = 'object' and octet_length(entry::text) <= 2000000),
  unique(task_id, project_key, session_id, subpath, entry_key)
);
create index design_session_entries_lookup_idx on public.design_session_entries(user_id, task_id, project_key, session_id, subpath, seq);

create table public.design_revisions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  result jsonb not null check (result->>'kind' = 'design' and octet_length(result::text) <= 4000000),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index design_revisions_task_idx on public.design_revisions(user_id, task_id, created_at);

-- No foreign key to the source revision/task: an implementation owns an independent frozen copy.
create table public.design_handoffs (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  snapshot jsonb not null,
  unique(user_id, idempotency_key)
);
create index design_handoffs_user_idx on public.design_handoffs(user_id);

alter table public.design_sessions enable row level security;
alter table public.design_session_entries enable row level security;
alter table public.design_revisions enable row level security;
alter table public.design_handoffs enable row level security;
revoke all on public.design_sessions, public.design_session_entries, public.design_revisions, public.design_handoffs from public, anon, authenticated;
grant select, insert, update, delete on public.design_sessions, public.design_session_entries, public.design_revisions, public.design_handoffs to service_role;
grant usage, select on sequence public.design_session_entries_seq_seq to service_role;

create function public.design_session_command(
  p_user_id uuid, p_job_id uuid, p_attempt integer, p_lease_token uuid, p_operation text, p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
  v_key jsonb := p_payload->'key';
  v_session uuid;
  v_entries jsonb;
  v_after bigint;
  v_next bigint;
  v_subkeys jsonb;
  v_entry jsonb;
begin
  select * into v_job from public.jobs where id = p_job_id and user_id = p_user_id for update;
  if not found or v_job.attempt <> p_attempt or v_job.lease_token is distinct from p_lease_token
    or v_job.status not in ('claimed', 'running') or v_job.cancel_requested_at is not null
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp()
    or v_job.payload->>'kind' is distinct from 'agent' or v_job.payload->'step'->>'output' is distinct from 'design' then
    raise exception using errcode = '23505', message = 'Design job lease has expired or been superseded';
  end if;
  update public.jobs set status = 'running' where id = v_job.id;
  if p_operation = 'read' then
    return jsonb_build_object('checkpoint', (
      select jsonb_build_object('sessionId', session_id, 'files', files, 'updatedAt', updated_at)
      from public.design_sessions where task_id = v_job.task_id and user_id = p_user_id
    ));
  end if;
  if p_operation = 'checkpoint' then
    if jsonb_typeof(p_payload->'files') <> 'array' or jsonb_array_length(p_payload->'files') > 100 then
      raise exception 'Invalid design checkpoint';
    end if;
    insert into public.design_sessions(task_id, user_id, session_id, files)
      values(v_job.task_id, p_user_id, (p_payload->>'sessionId')::uuid, p_payload->'files')
    on conflict(task_id) do update set files = excluded.files,
      session_id = coalesce(excluded.session_id, design_sessions.session_id), updated_at = clock_timestamp();
    return '{}'::jsonb;
  end if;
  if v_key->>'projectKey' is distinct from 'sindral-task-' || v_job.task_id::text then
    raise exception using errcode = '23505', message = 'Session workspace does not match the assigned task';
  end if;
  v_session := (v_key->>'sessionId')::uuid;
  if p_operation = 'load' then
    v_after := coalesce((p_payload->>'after')::bigint, 0);
    select coalesce(jsonb_agg(page.entry order by page.seq), '[]'::jsonb), max(page.seq)
      into v_entries, v_next
      from (select entry, seq, sum(octet_length(entry::text)) over(order by seq) as bytes from public.design_session_entries where user_id = p_user_id and task_id = v_job.task_id
        and project_key = v_key->>'projectKey' and session_id = v_session and subpath = coalesce(v_key->>'subpath', '')
        and seq > v_after order by seq limit 100) page where page.bytes <= 2100000;
    select coalesce(jsonb_agg(distinct subpath), '[]'::jsonb) into v_subkeys from public.design_session_entries
      where user_id = p_user_id and task_id = v_job.task_id and project_key = v_key->>'projectKey' and session_id = v_session and subpath <> '';
    return jsonb_build_object('entries', v_entries, 'nextAfter', v_next, 'subkeys', v_subkeys);
  end if;
  if p_operation <> 'append' or jsonb_typeof(p_payload->'entries') <> 'array'
    or jsonb_array_length(p_payload->'entries') not between 1 and 100 or octet_length((p_payload->'entries')::text) > 2500000 then
    raise exception 'Invalid session operation or transcript batch';
  end if;
  for v_entry in select value from jsonb_array_elements(p_payload->'entries') loop
    insert into public.design_session_entries(task_id, user_id, project_key, session_id, subpath, entry_key, entry)
      values(v_job.task_id, p_user_id, v_key->>'projectKey', v_session, coalesce(v_key->>'subpath', ''),
        coalesce(v_entry->>'uuid', md5(v_entry::text)), v_entry)
      on conflict(task_id, project_key, session_id, subpath, entry_key) do nothing;
  end loop;
  if coalesce(v_key->>'subpath', '') = '' then
    insert into public.design_sessions(task_id, user_id, session_id) values(v_job.task_id, p_user_id, v_session)
      on conflict(task_id) do update set session_id = excluded.session_id, updated_at = clock_timestamp();
  end if;
  return '{}'::jsonb;
end $$;

create function public.approve_design_revision(p_user_id uuid, p_task_id uuid, p_revision_id uuid, p_expected_version bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_task public.tasks%rowtype; v_revision public.design_revisions%rowtype;
begin
  select * into v_task from public.tasks where id = p_task_id and user_id = p_user_id for update;
  if not found or v_task.version <> p_expected_version or v_task.state <> 'design-review' then
    raise exception using errcode = '23505', message = 'Design changed; refresh before approving';
  end if;
  update public.design_revisions set approved_at = coalesce(approved_at, clock_timestamp())
    where id = p_revision_id and task_id = p_task_id and user_id = p_user_id returning * into v_revision;
  if not found then raise exception using errcode = '23505', message = 'Design revision is unavailable'; end if;
  return to_jsonb(v_revision);
end $$;

create function public.create_design_implementation_task(p_user_id uuid, p_task jsonb, p_revision_id uuid, p_idempotency_key uuid, p_request_hash text)
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
  insert into public.tasks(user_id, key, title, description, project_id, outcome, acceptance_criteria, state, workflow_id, repos, branch)
    values(p_user_id, p_task->>'key', p_task->>'title', coalesce(p_task->>'description', ''), (p_task->>'projectId')::uuid,
      coalesce(p_task->>'outcome', ''), coalesce(p_task->>'acceptanceCriteria', ''), 'todo', (p_task->>'workflowId')::uuid,
      array(select jsonb_array_elements_text(p_task->'repos')), p_task->>'branch') returning * into v_task;
  insert into public.design_handoffs(task_id, user_id, idempotency_key, request_hash, snapshot)
    values(v_task.id, p_user_id, p_idempotency_key, p_request_hash, jsonb_build_object(
      'sourceTaskId', v_revision.task_id, 'revisionId', v_revision.id, 'approvedAt', v_revision.approved_at, 'result', v_revision.result));
  return to_jsonb(v_task);
end $$;

revoke all on function public.design_session_command(uuid, uuid, integer, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.approve_design_revision(uuid, uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.create_design_implementation_task(uuid, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.design_session_command(uuid, uuid, integer, uuid, text, jsonb) to service_role;
grant execute on function public.approve_design_revision(uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.create_design_implementation_task(uuid, jsonb, uuid, uuid, text) to service_role;

create or replace function public.sindral_schema_version() returns text language sql stable security invoker set search_path = ''
as $$ select '20261025171114'::text $$;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;

-- Add the new bundled workflow once for existing accounts; later deletions remain intentional.
insert into public.workflows(id, user_id, name, definition, is_default)
select md5(user_id::text || ':claude-design')::uuid, user_id, 'Claude Design',
  jsonb_set('{"id":"wf-design","name":"Claude Design","description":"Describe an app, review and revise its design, then approve a version for implementation.","entryStepId":"todo","steps":[{"id":"todo","type":"human","label":"Design brief","state":"todo","position":{"x":40,"y":150}},{"id":"design","type":"agent","label":"Create design","state":"designing","engine":"claude","model":"claude-opus-5","mode":"high","output":"design","resumeSessionKey":"design","prompt":"Create or revise a real Claude Design artifact for this brief:\n{{task_description}}\n\nFeedback to address:\n{{feedback}}\n\nUse Claude Design''s built-in design capability. Work on the SAME external artifact across turns. Consult the restored conversation and exported files before changing anything. If retrying an interrupted operation, reconcile the existing artifact before publishing; never blindly create another design.\nAsk focused questions in your result when requirements are unclear. Preserve the current design while explaining what input is needed.\nExport a complete preview and implementation source into the output directory. Explain the design intent, component and token choices, interactions, responsive behavior, empty/loading/error states, open questions, and implementation acceptance criteria.\nInspect reference repositories when available, but do not modify them, commit, push, or create a PR. Design source belongs only in the design workspace.\nIf Design access, login, consent, or exports are unavailable, report the specific setup problem. Never invent a URL, claim success from a screenshot you did not export, or replace Claude Design with an independently generated local page.","tools":["read_file","write_file","run_command"],"permissions":["read","write","execute"],"position":{"x":220,"y":150}},{"id":"design-review","type":"human","label":"Review design","state":"design-review","position":{"x":410,"y":150}},{"id":"design-revise","type":"agent","label":"Revise design","state":"design-revising","engine":"claude","model":"claude-opus-5","mode":"high","output":"design","resumeSessionKey":"design","prompt":"Create or revise a real Claude Design artifact for this brief:\n{{task_description}}\n\nFeedback to address:\n{{feedback}}\n\nUse Claude Design''s built-in design capability. Work on the SAME external artifact across turns. Consult the restored conversation and exported files before changing anything. If retrying an interrupted operation, reconcile the existing artifact before publishing; never blindly create another design.\nAsk focused questions in your result when requirements are unclear. Preserve the current design while explaining what input is needed.\nExport a complete preview and implementation source into the output directory. Explain the design intent, component and token choices, interactions, responsive behavior, empty/loading/error states, open questions, and implementation acceptance criteria.\nInspect reference repositories when available, but do not modify them, commit, push, or create a PR. Design source belongs only in the design workspace.\nIf Design access, login, consent, or exports are unavailable, report the specific setup problem. Never invent a URL, claim success from a screenshot you did not export, or replace Claude Design with an independently generated local page.","tools":["read_file","write_file","run_command"],"permissions":["read","write","execute"],"position":{"x":220,"y":290}},{"id":"done","type":"end","label":"Approved design","state":"done","position":{"x":600,"y":150}}],"edges":[{"from":"todo","to":"design","event":"start","label":"Start designing"},{"from":"design","to":"design-review","event":"complete"},{"from":"design-review","to":"design-revise","event":"feedback","label":"Revise"},{"from":"design-revise","to":"design-review","event":"complete"},{"from":"design-review","to":"done","event":"accept","label":"Finish design"}],"troubleshootStep":{"id":"troubleshoot","type":"agent","label":"Troubleshoot Agent","state":"troubleshoot","engine":"claude","model":"claude-opus-5","mode":"high","output":"troubleshoot","tools":["read_file","write_file","run_command","search_codebase","list_directory"],"permissions":["read","write","execute"],"prompt":"You are a troubleshooting agent for task {{task_key}}: \"{{task_title}}\". A previous agent step failed.\n\nFollow the `debug-issue` skill if available. Diagnose the root cause from the error below, the repository state and the conversation with the user. If the problem is something you can safely fix in the workspace (broken dependency install, merge conflict, flaky environment, missing config that the user described in chat), fix it and set \"resolved\": true so the failed step can be retried. If the failure needs human action (missing permissions, credentials, product decisions), explain exactly what the user must do and set \"resolved\": false.\n\nError reported by the failed step:\n{{error}}\n\nTask description:\n{{task_description}}\n\nUser guidance from chat (may be empty):\n{{feedback}}"}}'::jsonb, '{id}', to_jsonb(md5(user_id::text || ':claude-design')::uuid::text)), false
from (select distinct user_id from public.workflows) owners
where not exists (select 1 from public.workflows w where w.user_id = owners.user_id and w.definition::text like '%"output": "design"%')
on conflict(id) do nothing;
