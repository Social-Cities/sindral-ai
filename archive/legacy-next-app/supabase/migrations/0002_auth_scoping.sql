-- Auth + per-user scoping. Every top-level row is owned by an auth.users id;
-- RLS enforces that authenticated users only see/mutate their own rows.
-- Child tables (task_plans, plan_messages, pr_messages, pr_files) inherit
-- ownership through their parent task.

-- ---------------------------------------------------------------------------
-- 1. Add owner_id to top-level tables.
-- ---------------------------------------------------------------------------

alter table humans     add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table projects   add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table teammates  add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table tasks      add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table activity   add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create index if not exists humans_owner_idx     on humans(owner_id);
create index if not exists projects_owner_idx   on projects(owner_id);
create index if not exists teammates_owner_idx  on teammates(owner_id);
create index if not exists tasks_owner_idx      on tasks(owner_id);
create index if not exists activity_owner_idx   on activity(owner_id);

-- ---------------------------------------------------------------------------
-- 2. Replace anon read policies with owner-scoped policies.
-- ---------------------------------------------------------------------------

drop policy if exists "anon read humans"        on humans;
drop policy if exists "anon read projects"      on projects;
drop policy if exists "anon read teammates"     on teammates;
drop policy if exists "anon read tasks"         on tasks;
drop policy if exists "anon read task_plans"    on task_plans;
drop policy if exists "anon read plan_messages" on plan_messages;
drop policy if exists "anon read pr_messages"   on pr_messages;
drop policy if exists "anon read pr_files"      on pr_files;
drop policy if exists "anon read activity"      on activity;

-- humans
create policy "owner read humans"  on humans for select using (auth.uid() = owner_id);
create policy "owner write humans" on humans for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- projects
create policy "owner read projects"  on projects for select using (auth.uid() = owner_id);
create policy "owner write projects" on projects for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- teammates
create policy "owner read teammates"  on teammates for select using (auth.uid() = owner_id);
create policy "owner write teammates" on teammates for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- tasks
create policy "owner read tasks"  on tasks for select using (auth.uid() = owner_id);
create policy "owner write tasks" on tasks for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- activity
create policy "owner read activity"  on activity for select using (auth.uid() = owner_id);
create policy "owner write activity" on activity for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- task_plans (inherits from tasks)
create policy "owner read task_plans" on task_plans for select using (
  exists (select 1 from tasks t where t.id = task_plans.task_id and t.owner_id = auth.uid())
);
create policy "owner write task_plans" on task_plans for all
  using (
    exists (select 1 from tasks t where t.id = task_plans.task_id and t.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from tasks t where t.id = task_plans.task_id and t.owner_id = auth.uid())
  );

-- plan_messages
create policy "owner read plan_messages" on plan_messages for select using (
  exists (select 1 from tasks t where t.id = plan_messages.task_id and t.owner_id = auth.uid())
);
create policy "owner write plan_messages" on plan_messages for all
  using (
    exists (select 1 from tasks t where t.id = plan_messages.task_id and t.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from tasks t where t.id = plan_messages.task_id and t.owner_id = auth.uid())
  );

-- pr_messages
create policy "owner read pr_messages" on pr_messages for select using (
  exists (select 1 from tasks t where t.id = pr_messages.task_id and t.owner_id = auth.uid())
);
create policy "owner write pr_messages" on pr_messages for all
  using (
    exists (select 1 from tasks t where t.id = pr_messages.task_id and t.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from tasks t where t.id = pr_messages.task_id and t.owner_id = auth.uid())
  );

-- pr_files
create policy "owner read pr_files" on pr_files for select using (
  exists (select 1 from tasks t where t.id = pr_files.task_id and t.owner_id = auth.uid())
);
create policy "owner write pr_files" on pr_files for all
  using (
    exists (select 1 from tasks t where t.id = pr_files.task_id and t.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from tasks t where t.id = pr_files.task_id and t.owner_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3. New-user bootstrap: create the user's own "You" humans row + a starter
--    set of demo data scoped to them. Keeps the demo experience working
--    without leaking any data across accounts.
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_workspace_for_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid_short text := substr(p_user::text, 1, 8);
  -- Per-user, deterministic ids. Suffixed with the user's short uuid so
  -- they're unique across the global text-keyed tables.
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
begin
  if exists (select 1 from humans where id = me_id) then
    return;
  end if;

  select u.email into email from auth.users u where u.id = p_user;
  display_name := coalesce(split_part(email, '@', 1), 'You');

  insert into humans (id, name, hue, short, owner_id) values
    (me_id, display_name, 30, upper(substr(display_name, 1, 1)), p_user),
    (h2_id, 'Mira Cho', 200, 'MC', p_user),
    (h3_id, 'Sam Park', 80,  'SP', p_user);

  insert into projects (id, name, repo, emoji, description, active, position, owner_id) values
    (p1_id, 'kettle',     'agatha/kettle',     '🫖', 'A Rust/TypeScript CLI for orchestrating coding agents across many sandboxes.', true,  0, p_user),
    (p2_id, 'beacon-api', 'agatha/beacon-api', '◐',  null, false, 1, p_user),
    (p3_id, 'lattice',    'agatha/lattice',    '◇',  null, false, 2, p_user);

  insert into teammates (id, name, role, model, hue, status, task_id, position, owner_id) values
    (a1_id, 'Iris',  'planner',     'claude-haiku-5', 268, 'working', t142, 0, p_user),
    (a2_id, 'Atlas', 'implementer', 'codex-2',         18, 'working', t138, 1, p_user),
    (a3_id, 'Juno',  'implementer', 'claude-haiku-5', 142, 'online',  null, 2, p_user),
    (a4_id, 'Echo',  'reviewer',    'claude-haiku-5', 220, 'online',  null, 3, p_user),
    (a5_id, 'Pax',   'planner',     'codex-2',        340, 'idle',    null, 4, p_user);

  insert into tasks (id, project_id, type, title, state, agent_id, assignee_id, branch, priority, updated, owner_id) values
    (t142, p1_id, 'feature',  'Streaming SSE proxy for /v1/messages with backpressure',     'planning',   a1_id, me_id, null,                       'high', '2m',  p_user),
    (t138, p1_id, 'feature',  'Replace polling worker queue with Postgres LISTEN/NOTIFY',    'inProgress', a2_id, h2_id, 'atlas/listen-notify',      'high', '14m', p_user),
    (t140, p1_id, 'bug',      'Race condition in branch cleanup when worker crashes mid-PR', 'prOpen',     a3_id, me_id, 'juno/branch-cleanup-race', 'high', '1h',  p_user),
    (t139, p1_id, 'refactor', 'Extract sandbox lifecycle into its own crate',                'planReady',  a5_id, null,  null,                       'med',  '3h',  p_user),
    (t141, p1_id, 'chore',    'Bump tokio to 1.39, drop deprecated time helpers',            'backlog',    null,  null,  null,                       'low',  '5h',  p_user),
    (t137, p1_id, 'spike',    'Investigate per-task sandbox snapshot for instant resume',    'backlog',    null,  h2_id, null,                       'med',  '1d',  p_user),
    (t136, p1_id, 'docs',     'Document the worker→agent handshake protocol',                'backlog',    null,  null,  null,                       'low',  '1d',  p_user),
    (t135, p1_id, 'bug',      'PR diff viewer scrolls past file boundary on large hunks',    'merged',     a3_id, h3_id, 'juno/diff-scroll',         'med',  '2d',  p_user),
    (t134, p1_id, 'feature',  'Add @-mention triggers in plan composer for file refs',       'merged',     a2_id, me_id, 'atlas/at-mention',         'med',  '3d',  p_user);

  insert into activity (id, who_id, verb, target, detail, t, owner_id) values
    ('f1-' || uid_short, a2_id, 'pushed 2 commits to',   t138, 'atlas/listen-notify', '4m',  p_user),
    ('f2-' || uid_short, h2_id, 'commented on',          t138, 'Can you also bump the connection pool…', '11m', p_user),
    ('f3-' || uid_short, a1_id, 'is drafting a plan for', t142, 'Streaming SSE proxy', '12m', p_user),
    ('f4-' || uid_short, a3_id, 'opened PR for',         t140, '#284 — Race condition in branch cleanup', '1h', p_user),
    ('f5-' || uid_short, me_id, 'created',               t142, 'Streaming SSE proxy for /v1/messages', '1h',   p_user),
    ('f6-' || uid_short, a3_id, 'merged',                t135, 'PR diff viewer scrolls past file boundary', '2d', p_user);
end;
$$;

-- Trigger: bootstrap a workspace whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.bootstrap_workspace_for_user(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
