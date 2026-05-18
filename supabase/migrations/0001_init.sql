-- Sindral AI Teams initial schema.
-- Snake_case columns; the app maps them to camelCase via the query layer.

create table if not exists humans (
  id text primary key,
  name text not null,
  hue int not null,
  short text not null
);

create table if not exists projects (
  id text primary key,
  name text not null,
  repo text not null,
  emoji text not null,
  description text,
  active boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists teammates (
  id text primary key,
  name text not null,
  role text not null check (role in ('planner','implementer','reviewer')),
  model text not null,
  hue int not null,
  status text not null check (status in ('working','online','idle')),
  task_id text,
  position int not null default 0
);

create table if not exists tasks (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  type text not null check (type in ('feature','bug','chore','refactor','spike','docs')),
  title text not null,
  state text not null check (state in ('backlog','planning','planReady','inProgress','prOpen','merged','blocked')),
  agent_id text references teammates(id) on delete set null,
  assignee_id text references humans(id) on delete set null,
  branch text,
  priority text not null check (priority in ('high','med','low')),
  updated text not null,
  created_at timestamptz not null default now()
);

create index if not exists tasks_project_idx on tasks(project_id);
create index if not exists tasks_state_idx on tasks(state);

create table if not exists task_plans (
  task_id text primary key references tasks(id) on delete cascade,
  markdown text not null,
  streaming_partial text
);

create table if not exists plan_messages (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  from_id text not null,
  kind text not null check (kind in ('msg','event','tool')),
  t text,
  body text not null,
  position int not null
);

create index if not exists plan_messages_task_idx on plan_messages(task_id, position);

create table if not exists pr_messages (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  from_id text not null,
  kind text not null check (kind in ('msg','event','tool')),
  t text,
  body text not null,
  position int not null
);

create index if not exists pr_messages_task_idx on pr_messages(task_id, position);

create table if not exists pr_files (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references tasks(id) on delete cascade,
  path text not null,
  additions int not null default 0,
  deletions int not null default 0,
  hunks jsonb not null,
  position int not null
);

create index if not exists pr_files_task_idx on pr_files(task_id, position);

create table if not exists activity (
  id text primary key,
  who_id text not null,
  verb text not null,
  target text not null,
  detail text not null,
  t text not null,
  created_at timestamptz not null default now()
);

-- Read-only access for the anon key. Mutations go through service role
-- (server actions) only.
alter table humans       enable row level security;
alter table projects     enable row level security;
alter table teammates    enable row level security;
alter table tasks        enable row level security;
alter table task_plans   enable row level security;
alter table plan_messages enable row level security;
alter table pr_messages  enable row level security;
alter table pr_files     enable row level security;
alter table activity     enable row level security;

create policy "anon read humans"        on humans        for select using (true);
create policy "anon read projects"      on projects      for select using (true);
create policy "anon read teammates"     on teammates     for select using (true);
create policy "anon read tasks"         on tasks         for select using (true);
create policy "anon read task_plans"    on task_plans    for select using (true);
create policy "anon read plan_messages" on plan_messages for select using (true);
create policy "anon read pr_messages"   on pr_messages   for select using (true);
create policy "anon read pr_files"      on pr_files      for select using (true);
create policy "anon read activity"      on activity      for select using (true);
