-- Multi-tenancy via organizations.
--
-- Until now every owner-scoped table was gated by `auth.uid() = owner_id`.
-- This migration introduces organizations as the tenancy boundary: data is
-- scoped to an org, and users access an org by being a row in org_members.
-- owner_id stays on every table as the "created_by" audit field, but the
-- RLS check switches to membership in the row's org_id.
--
-- Backfill creates one personal org per existing distinct owner_id, adds
-- that user as the org's owner, and copies the org_id onto every row they
-- previously owned. After the backfill, org_id is set NOT NULL on every
-- scoped table.

-- ---------------------------------------------------------------------------
-- 1. Core org tables.
-- ---------------------------------------------------------------------------

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists organizations_created_by_idx on organizations(created_by);

create table if not exists org_members (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists org_members_user_idx on org_members(user_id);

create table if not exists org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  token text not null unique,
  email text,
  role text not null check (role in ('admin','member')),
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists org_invitations_org_idx on org_invitations(org_id);
create index if not exists org_invitations_pending_idx
  on org_invitations(org_id)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- 2. Membership helper. Called from every RLS policy. SECURITY DEFINER so
--    the policy check doesn't recurse through RLS on org_members itself.
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from org_members
    where org_id = p_org
      and user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from org_members
    where org_id = p_org
      and user_id = auth.uid()
      and role = any(p_roles)
  );
$$;

grant execute on function public.is_org_member(uuid)        to authenticated;
grant execute on function public.has_org_role(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Add nullable org_id to every owner-scoped table.
-- ---------------------------------------------------------------------------

alter table humans              add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table projects            add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table teammates           add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table tasks               add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table activity            add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table task_jobs           add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table task_job_events     add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table task_conversations  add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table task_memories       add column if not exists org_id uuid references organizations(id) on delete cascade;

create index if not exists humans_org_idx             on humans(org_id);
create index if not exists projects_org_idx           on projects(org_id);
create index if not exists teammates_org_idx          on teammates(org_id);
create index if not exists tasks_org_idx              on tasks(org_id);
create index if not exists activity_org_idx           on activity(org_id);
create index if not exists task_jobs_org_idx          on task_jobs(org_id);
create index if not exists task_job_events_org_idx    on task_job_events(org_id);
create index if not exists task_conversations_org_idx on task_conversations(org_id);
create index if not exists task_memories_org_idx      on task_memories(org_id);

-- ---------------------------------------------------------------------------
-- 4. Backfill: create a personal org for every distinct owner_id and copy
--    that org_id onto all rows that user owns. Runs once, idempotent on
--    re-application thanks to ON CONFLICT.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  v_org_id uuid;
  v_email text;
  v_name text;
  v_slug text;
begin
  for r in
    select distinct owner_id
    from (
      select owner_id from humans     where owner_id is not null union
      select owner_id from projects   where owner_id is not null union
      select owner_id from teammates  where owner_id is not null union
      select owner_id from tasks      where owner_id is not null union
      select owner_id from activity   where owner_id is not null union
      select owner_id from task_jobs  where owner_id is not null union
      select owner_id from task_job_events    where owner_id is not null union
      select owner_id from task_conversations where owner_id is not null union
      select owner_id from task_memories      where owner_id is not null
    ) all_owners
  loop
    select u.email into v_email from auth.users u where u.id = r.owner_id;
    v_name := coalesce(split_part(v_email, '@', 1), 'Personal') || '''s workspace';
    v_slug := 'personal-' || substr(r.owner_id::text, 1, 8);

    insert into organizations (name, slug, created_by)
      values (v_name, v_slug, r.owner_id)
      on conflict (slug) do update set name = excluded.name
      returning id into v_org_id;

    insert into org_members (org_id, user_id, role)
      values (v_org_id, r.owner_id, 'owner')
      on conflict (org_id, user_id) do nothing;

    update humans             set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update projects           set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update teammates          set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update tasks              set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update activity           set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update task_jobs          set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update task_job_events    set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update task_conversations set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
    update task_memories      set org_id = v_org_id where owner_id = r.owner_id and org_id is null;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Enforce org_id NOT NULL now that backfill is done.
-- ---------------------------------------------------------------------------

alter table humans             alter column org_id set not null;
alter table projects           alter column org_id set not null;
alter table teammates          alter column org_id set not null;
alter table tasks              alter column org_id set not null;
alter table activity           alter column org_id set not null;
alter table task_jobs          alter column org_id set not null;
alter table task_job_events    alter column org_id set not null;
alter table task_conversations alter column org_id set not null;
alter table task_memories      alter column org_id set not null;

-- ---------------------------------------------------------------------------
-- 6. Swap RLS from owner_id-based to org-membership-based.
-- ---------------------------------------------------------------------------

-- humans
drop policy if exists "owner read humans"  on humans;
drop policy if exists "owner write humans" on humans;
create policy "org read humans"  on humans for select using (public.is_org_member(org_id));
create policy "org write humans" on humans for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- projects
drop policy if exists "owner read projects"  on projects;
drop policy if exists "owner write projects" on projects;
create policy "org read projects"  on projects for select using (public.is_org_member(org_id));
create policy "org write projects" on projects for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- teammates
drop policy if exists "owner read teammates"  on teammates;
drop policy if exists "owner write teammates" on teammates;
create policy "org read teammates"  on teammates for select using (public.is_org_member(org_id));
create policy "org write teammates" on teammates for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- tasks
drop policy if exists "owner read tasks"  on tasks;
drop policy if exists "owner write tasks" on tasks;
create policy "org read tasks"  on tasks for select using (public.is_org_member(org_id));
create policy "org write tasks" on tasks for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- activity
drop policy if exists "owner read activity"  on activity;
drop policy if exists "owner write activity" on activity;
create policy "org read activity"  on activity for select using (public.is_org_member(org_id));
create policy "org write activity" on activity for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- task_jobs
drop policy if exists "owner read task_jobs"  on task_jobs;
drop policy if exists "owner write task_jobs" on task_jobs;
create policy "org read task_jobs"  on task_jobs for select using (public.is_org_member(org_id));
create policy "org write task_jobs" on task_jobs for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- task_job_events
drop policy if exists "owner read task_job_events"  on task_job_events;
drop policy if exists "owner write task_job_events" on task_job_events;
create policy "org read task_job_events"  on task_job_events for select using (public.is_org_member(org_id));
create policy "org write task_job_events" on task_job_events for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- task_conversations
drop policy if exists "owner read task_conversations"  on task_conversations;
drop policy if exists "owner write task_conversations" on task_conversations;
create policy "org read task_conversations"  on task_conversations for select using (public.is_org_member(org_id));
create policy "org write task_conversations" on task_conversations for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- task_memories
drop policy if exists "owner read task_memories"  on task_memories;
drop policy if exists "owner write task_memories" on task_memories;
create policy "org read task_memories"  on task_memories for select using (public.is_org_member(org_id));
create policy "org write task_memories" on task_memories for all
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- task_plans (inherits via parent task)
drop policy if exists "owner read task_plans"  on task_plans;
drop policy if exists "owner write task_plans" on task_plans;
create policy "org read task_plans" on task_plans for select using (
  exists (select 1 from tasks t where t.id = task_plans.task_id and public.is_org_member(t.org_id))
);
create policy "org write task_plans" on task_plans for all
  using (
    exists (select 1 from tasks t where t.id = task_plans.task_id and public.is_org_member(t.org_id))
  )
  with check (
    exists (select 1 from tasks t where t.id = task_plans.task_id and public.is_org_member(t.org_id))
  );

-- plan_messages
drop policy if exists "owner read plan_messages"  on plan_messages;
drop policy if exists "owner write plan_messages" on plan_messages;
create policy "org read plan_messages" on plan_messages for select using (
  exists (select 1 from tasks t where t.id = plan_messages.task_id and public.is_org_member(t.org_id))
);
create policy "org write plan_messages" on plan_messages for all
  using (
    exists (select 1 from tasks t where t.id = plan_messages.task_id and public.is_org_member(t.org_id))
  )
  with check (
    exists (select 1 from tasks t where t.id = plan_messages.task_id and public.is_org_member(t.org_id))
  );

-- pr_messages
drop policy if exists "owner read pr_messages"  on pr_messages;
drop policy if exists "owner write pr_messages" on pr_messages;
create policy "org read pr_messages" on pr_messages for select using (
  exists (select 1 from tasks t where t.id = pr_messages.task_id and public.is_org_member(t.org_id))
);
create policy "org write pr_messages" on pr_messages for all
  using (
    exists (select 1 from tasks t where t.id = pr_messages.task_id and public.is_org_member(t.org_id))
  )
  with check (
    exists (select 1 from tasks t where t.id = pr_messages.task_id and public.is_org_member(t.org_id))
  );

-- pr_files
drop policy if exists "owner read pr_files"  on pr_files;
drop policy if exists "owner write pr_files" on pr_files;
create policy "org read pr_files" on pr_files for select using (
  exists (select 1 from tasks t where t.id = pr_files.task_id and public.is_org_member(t.org_id))
);
create policy "org write pr_files" on pr_files for all
  using (
    exists (select 1 from tasks t where t.id = pr_files.task_id and public.is_org_member(t.org_id))
  )
  with check (
    exists (select 1 from tasks t where t.id = pr_files.task_id and public.is_org_member(t.org_id))
  );

-- ---------------------------------------------------------------------------
-- 7. RLS on the org tables themselves.
-- ---------------------------------------------------------------------------

alter table organizations    enable row level security;
alter table org_members      enable row level security;
alter table org_invitations  enable row level security;

-- organizations: members can read; only owners/admins can update; creation
-- happens via security-definer create_organization() so we can also insert
-- the membership in the same transaction without recursive RLS.
drop policy if exists "members read organizations"  on organizations;
drop policy if exists "owners update organizations" on organizations;
create policy "members read organizations"  on organizations for select using (public.is_org_member(id));
create policy "owners update organizations" on organizations for update
  using (public.has_org_role(id, array['owner','admin']))
  with check (public.has_org_role(id, array['owner','admin']));

-- org_members: a user can read members of any org they belong to, and
-- their own membership rows. Only owners/admins can write membership rows.
drop policy if exists "members read org_members"  on org_members;
drop policy if exists "owners write org_members"  on org_members;
create policy "members read org_members" on org_members for select using (
  user_id = auth.uid() or public.is_org_member(org_id)
);
create policy "owners write org_members" on org_members for all
  using (public.has_org_role(org_id, array['owner','admin']))
  with check (public.has_org_role(org_id, array['owner','admin']));

-- org_invitations: members of the org can list; only owners/admins can
-- create or revoke. The accept path goes through accept_org_invitation()
-- which runs SECURITY DEFINER and bypasses these policies.
drop policy if exists "members read org_invitations"  on org_invitations;
drop policy if exists "owners write org_invitations"  on org_invitations;
create policy "members read org_invitations" on org_invitations for select using (
  public.is_org_member(org_id)
);
create policy "owners write org_invitations" on org_invitations for all
  using (public.has_org_role(org_id, array['owner','admin']))
  with check (public.has_org_role(org_id, array['owner','admin']));

-- ---------------------------------------------------------------------------
-- 8. Security-definer helpers for create / join.
-- ---------------------------------------------------------------------------

create or replace function public.create_organization(p_name text, p_slug text)
returns organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_org organizations;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'name is required';
  end if;
  if coalesce(trim(p_slug), '') = '' then
    raise exception 'slug is required';
  end if;

  insert into organizations (name, slug, created_by)
    values (trim(p_name), trim(p_slug), v_user)
    returning * into v_org;

  insert into org_members (org_id, user_id, role)
    values (v_org.id, v_user, 'owner');

  return v_org;
end;
$$;

grant execute on function public.create_organization(text, text) to authenticated;

create or replace function public.accept_org_invitation(p_token text)
returns org_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_invite org_invitations;
  v_member org_members;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from org_invitations
  where token = p_token
  for update;

  if not found then
    raise exception 'invitation not found';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invitation already accepted';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invitation revoked';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at < now() then
    raise exception 'invitation expired';
  end if;

  insert into org_members (org_id, user_id, role)
    values (v_invite.org_id, v_user, v_invite.role)
    on conflict (org_id, user_id) do update set role = excluded.role
    returning * into v_member;

  update org_invitations
    set accepted_at = now(), accepted_by = v_user
    where id = v_invite.id;

  return v_member;
end;
$$;

grant execute on function public.accept_org_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8b. Auto-fill org_id on child rows from the parent task. Existing worker
--     code (sindral-ai-workers) inserts task_jobs / task_job_events /
--     task_conversations / task_memories with only owner_id + task_id;
--     these triggers copy the task's org_id forward so the NOT NULL
--     constraint holds without a worker-side change.
-- ---------------------------------------------------------------------------

create or replace function public.fill_org_id_from_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from tasks where id = new.task_id;
  end if;
  return new;
end;
$$;

drop trigger if exists task_jobs_fill_org on task_jobs;
create trigger task_jobs_fill_org
  before insert on task_jobs
  for each row execute function public.fill_org_id_from_task();

drop trigger if exists task_job_events_fill_org on task_job_events;
create trigger task_job_events_fill_org
  before insert on task_job_events
  for each row execute function public.fill_org_id_from_task();

drop trigger if exists task_conversations_fill_org on task_conversations;
create trigger task_conversations_fill_org
  before insert on task_conversations
  for each row execute function public.fill_org_id_from_task();

drop trigger if exists task_memories_fill_org on task_memories;
create trigger task_memories_fill_org
  before insert on task_memories
  for each row execute function public.fill_org_id_from_task();

-- ---------------------------------------------------------------------------
-- 9. Replace the per-user bootstrap so new sign-ups get a personal org
--    and the demo data is scoped to that org.
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_workspace_for_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid_short text := substr(p_user::text, 1, 8);
  me_id text := p_user::text;
  h2_id text := 'h2-' || uid_short;
  h3_id text := 'h3-' || uid_short;
  p1_id text := 'p1-' || uid_short;
  p2_id text := 'p2-' || uid_short;
  p3_id text := 'p3-' || uid_short;
  a1_id text := 'a1-' || uid_short;
  a2_id text := 'a2-' || uid_short;
  a3_id text := 'a3-' || uid_short;
  a4_id text := 'a4-' || uid_short;
  a5_id text := 'a5-' || uid_short;
  t142  text := 'AGT-142-' || uid_short;
  t138  text := 'AGT-138-' || uid_short;
  t140  text := 'AGT-140-' || uid_short;
  t139  text := 'AGT-139-' || uid_short;
  t141  text := 'AGT-141-' || uid_short;
  t137  text := 'AGT-137-' || uid_short;
  t136  text := 'AGT-136-' || uid_short;
  t135  text := 'AGT-135-' || uid_short;
  t134  text := 'AGT-134-' || uid_short;
  email text;
  display_name text;
  v_org_id uuid;
  v_org_name text;
  v_org_slug text;
begin
  if exists (select 1 from humans where id = me_id) then
    return;
  end if;

  select u.email into email from auth.users u where u.id = p_user;
  display_name := coalesce(split_part(email, '@', 1), 'You');

  v_org_name := display_name || '''s workspace';
  v_org_slug := 'personal-' || uid_short;

  insert into organizations (name, slug, created_by)
    values (v_org_name, v_org_slug, p_user)
    on conflict (slug) do update set name = excluded.name
    returning id into v_org_id;

  insert into org_members (org_id, user_id, role)
    values (v_org_id, p_user, 'owner')
    on conflict (org_id, user_id) do nothing;

  insert into humans (id, name, hue, short, owner_id, org_id) values
    (me_id, display_name, 30, upper(substr(display_name, 1, 1)), p_user, v_org_id),
    (h2_id, 'Mira Cho', 200, 'MC', p_user, v_org_id),
    (h3_id, 'Sam Park', 80,  'SP', p_user, v_org_id);

  insert into projects (id, name, repo, emoji, description, active, position, owner_id, org_id) values
    (p1_id, 'kettle',     'agatha/kettle',     '🫖', 'A Rust/TypeScript CLI for orchestrating coding agents across many sandboxes.', true,  0, p_user, v_org_id),
    (p2_id, 'beacon-api', 'agatha/beacon-api', '◐',  null, false, 1, p_user, v_org_id),
    (p3_id, 'lattice',    'agatha/lattice',    '◇',  null, false, 2, p_user, v_org_id);

  insert into teammates (id, name, role, model, hue, status, task_id, position, owner_id, org_id) values
    (a1_id, 'Iris',  'planner',     'claude-haiku-5', 268, 'working', t142, 0, p_user, v_org_id),
    (a2_id, 'Atlas', 'implementer', 'codex-2',         18, 'working', t138, 1, p_user, v_org_id),
    (a3_id, 'Juno',  'implementer', 'claude-haiku-5', 142, 'online',  null, 2, p_user, v_org_id),
    (a4_id, 'Echo',  'reviewer',    'claude-haiku-5', 220, 'online',  null, 3, p_user, v_org_id),
    (a5_id, 'Pax',   'planner',     'codex-2',        340, 'idle',    null, 4, p_user, v_org_id);

  insert into tasks (id, project_id, type, title, state, agent_id, assignee_id, branch, priority, updated, owner_id, org_id) values
    (t142, p1_id, 'feature',  'Streaming SSE proxy for /v1/messages with backpressure',     'planning',   a1_id, me_id, null,                       'high', '2m',  p_user, v_org_id),
    (t138, p1_id, 'feature',  'Replace polling worker queue with Postgres LISTEN/NOTIFY',    'inProgress', a2_id, h2_id, 'atlas/listen-notify',      'high', '14m', p_user, v_org_id),
    (t140, p1_id, 'bug',      'Race condition in branch cleanup when worker crashes mid-PR', 'prOpen',     a3_id, me_id, 'juno/branch-cleanup-race', 'high', '1h',  p_user, v_org_id),
    (t139, p1_id, 'refactor', 'Extract sandbox lifecycle into its own crate',                'planReady',  a5_id, null,  null,                       'med',  '3h',  p_user, v_org_id),
    (t141, p1_id, 'chore',    'Bump tokio to 1.39, drop deprecated time helpers',            'backlog',    null,  null,  null,                       'low',  '5h',  p_user, v_org_id),
    (t137, p1_id, 'spike',    'Investigate per-task sandbox snapshot for instant resume',    'backlog',    null,  h2_id, null,                       'med',  '1d',  p_user, v_org_id),
    (t136, p1_id, 'docs',     'Document the worker→agent handshake protocol',                'backlog',    null,  null,  null,                       'low',  '1d',  p_user, v_org_id),
    (t135, p1_id, 'bug',      'PR diff viewer scrolls past file boundary on large hunks',    'merged',     a3_id, h3_id, 'juno/diff-scroll',         'med',  '2d',  p_user, v_org_id),
    (t134, p1_id, 'feature',  'Add @-mention triggers in plan composer for file refs',       'merged',     a2_id, me_id, 'atlas/at-mention',         'med',  '3d',  p_user, v_org_id);

  insert into activity (id, who_id, verb, target, detail, t, owner_id, org_id) values
    ('f1-' || uid_short, a2_id, 'pushed 2 commits to',   t138, 'atlas/listen-notify', '4m',  p_user, v_org_id),
    ('f2-' || uid_short, h2_id, 'commented on',          t138, 'Can you also bump the connection pool…', '11m', p_user, v_org_id),
    ('f3-' || uid_short, a1_id, 'is drafting a plan for', t142, 'Streaming SSE proxy', '12m', p_user, v_org_id),
    ('f4-' || uid_short, a3_id, 'opened PR for',         t140, '#284 — Race condition in branch cleanup', '1h', p_user, v_org_id),
    ('f5-' || uid_short, me_id, 'created',               t142, 'Streaming SSE proxy for /v1/messages', '1h',   p_user, v_org_id),
    ('f6-' || uid_short, a3_id, 'merged',                t135, 'PR diff viewer scrolls past file boundary', '2d', p_user, v_org_id);
end;
$$;
