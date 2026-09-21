-- Sindral AI initial schema.
-- Every table is scoped by user_id and protected with RLS. The server uses the
-- service role key and additionally scopes every query by the verified user id;
-- RLS is defense in depth for any direct client access.

create extension if not exists "pgcrypto";

-- ---------- helpers ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  github_username text,
  task_counter integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Atomically allocate the next task number for a user (used for SIN-n keys).
create or replace function public.next_task_number(p_user_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.profiles (id) values (p_user_id) on conflict (id) do nothing;
  update public.profiles set task_counter = task_counter + 1 where id = p_user_id returning task_counter into n;
  return n;
end $$;
revoke all on function public.next_task_number(uuid) from public, anon, authenticated;

-- ---------- user secrets (encrypted provider tokens) ----------
create table public.user_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github', 'linear', 'jira')),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  hint text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
create trigger user_secrets_updated_at before update on public.user_secrets for each row execute function public.set_updated_at();

-- ---------- worker keys ----------
create table public.worker_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index worker_keys_user_idx on public.worker_keys(user_id);

-- ---------- workers ----------
create table public.workers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  worker_key_id uuid references public.worker_keys(id) on delete set null,
  name text not null,
  hostname text not null,
  version text not null,
  status text not null default 'online' check (status in ('online', 'offline')),
  running_jobs integer not null default 0,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index workers_user_idx on public.workers(user_id);

-- ---------- workflows ----------
create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  definition jsonb not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflows_user_idx on public.workflows(user_id);
create trigger workflows_updated_at before update on public.workflows for each row execute function public.set_updated_at();

-- ---------- tasks ----------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  title text not null,
  description text not null default '',
  state text not null default 'todo',
  current_step_id text,
  workflow_id uuid references public.workflows(id) on delete set null,
  pinned_workflow jsonb,
  repos text[] not null default '{}',
  ticket_url text,
  pr_url text,
  branch text,
  base_branch text,
  plan text,
  parent_task_id uuid references public.tasks(id) on delete cascade,
  sequence integer,
  failed_step_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
create index tasks_user_state_idx on public.tasks(user_id, state);
create index tasks_parent_idx on public.tasks(parent_task_id, sequence);
create index tasks_pr_url_idx on public.tasks(pr_url) where pr_url is not null;
create trigger tasks_updated_at before update on public.tasks for each row execute function public.set_updated_at();

-- ---------- task messages ----------
create table public.task_messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'agent', 'system')),
  source text not null default 'web' check (source in ('web', 'github', 'worker')),
  content text not null,
  external_id text,
  created_at timestamptz not null default now()
);
create index task_messages_task_idx on public.task_messages(task_id, created_at);
create unique index task_messages_external_idx on public.task_messages(task_id, external_id) where external_id is not null;

-- ---------- task events (audit timeline) ----------
create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  from_state text,
  to_state text,
  step_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index task_events_task_idx on public.task_events(task_id, created_at);

-- ---------- artifacts (non-code outputs, review reports) ----------
create table public.task_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  name text not null,
  content_type text not null default 'text/markdown',
  content text not null,
  created_at timestamptz not null default now(),
  constraint task_artifacts_size check (octet_length(content) <= 1048576)
);
create index task_artifacts_task_idx on public.task_artifacts(task_id, created_at);

-- ---------- jobs ----------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind text not null check (kind in ('agent', 'rebase-stack')),
  step_id text,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  worker_id uuid references public.workers(id) on delete set null,
  attempt integer not null default 1,
  payload jsonb not null,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
create index jobs_user_status_idx on public.jobs(user_id, status, created_at);
create index jobs_task_idx on public.jobs(task_id, created_at);

-- Atomically claim queued jobs for a worker. Jobs for the same task are serialised:
-- a job is only claimable when no other job for that task is claimed/running.
create or replace function public.claim_jobs(p_user_id uuid, p_worker_id uuid, p_max integer)
returns setof public.jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    -- one job per task per claim, oldest first, skipping rows locked by concurrent claims
    select distinct on (j.task_id) j.id, j.task_id, j.created_at
    from public.jobs j
    where j.user_id = p_user_id
      and j.status = 'queued'
      and not exists (
        select 1 from public.jobs o
        where o.task_id = j.task_id and o.status in ('claimed', 'running')
      )
    order by j.task_id, j.created_at
    for update skip locked
  ),
  picked as (
    select id from candidates order by created_at limit greatest(1, least(p_max, 10))
  )
  update public.jobs j
  set status = 'claimed', worker_id = p_worker_id, claimed_at = now()
  from picked c
  where j.id = c.id
  returning j.*;
end $$;
revoke all on function public.claim_jobs(uuid, uuid, integer) from public, anon, authenticated;

-- ---------- job logs ----------
create table public.job_logs (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('log', 'progress', 'message')),
  message text not null,
  created_at timestamptz not null default now()
);
create index job_logs_job_idx on public.job_logs(job_id, id);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.user_secrets enable row level security;
alter table public.worker_keys enable row level security;
alter table public.workers enable row level security;
alter table public.workflows enable row level security;
alter table public.tasks enable row level security;
alter table public.task_messages enable row level security;
alter table public.task_events enable row level security;
alter table public.task_artifacts enable row level security;
alter table public.jobs enable row level security;
alter table public.job_logs enable row level security;

-- Users may read/update their own profile only.
create policy profiles_select on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Secrets and worker keys are never readable by clients; only the service role (server) touches them.
-- (No policies => authenticated/anon are denied. Service role bypasses RLS.)

-- Read-only visibility for the owner on operational tables; all writes go through the server.
create policy workers_select on public.workers for select to authenticated using (user_id = (select auth.uid()));
create policy workflows_select on public.workflows for select to authenticated using (user_id = (select auth.uid()));
create policy tasks_select on public.tasks for select to authenticated using (user_id = (select auth.uid()));
create policy task_messages_select on public.task_messages for select to authenticated using (user_id = (select auth.uid()));
create policy task_events_select on public.task_events for select to authenticated using (user_id = (select auth.uid()));
create policy task_artifacts_select on public.task_artifacts for select to authenticated using (user_id = (select auth.uid()));
create policy jobs_select on public.jobs for select to authenticated using (user_id = (select auth.uid()));
create policy job_logs_select on public.job_logs for select to authenticated using (user_id = (select auth.uid()));

-- Lock down the public schema defaults.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
