-- task_jobs: durable execution record per plan/implement/review attempt.
-- One row per workflow execution attempt against a persona. The workflow
-- writes status transitions back here so the API can return job state
-- without querying Temporal directly. idempotency_key prevents duplicate
-- dispatch on API/queue retries.

create table if not exists task_jobs (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references tasks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  persona_id text not null references teammates(id) on delete cascade,
  job_type text not null check (job_type in ('plan','implement','review')),
  required_role text not null check (required_role in ('planner','implementer','reviewer')),
  runtime text not null check (runtime in ('codex','claude_code')),
  status text not null default 'queued'
    check (status in ('queued','dispatching','running','succeeded','failed','cancelled')),
  workflow_id text,
  workflow_run_id text,
  idempotency_key text not null,
  attempt int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- DB-level enforcement of role/job compatibility (3.4 in plan).
  constraint task_jobs_role_job_match check (
    (job_type = 'plan'      and required_role = 'planner')     or
    (job_type = 'implement' and required_role = 'implementer') or
    (job_type = 'review'    and required_role = 'reviewer')
  )
);

create unique index if not exists task_jobs_idempotency_key_uniq
  on task_jobs(idempotency_key);
create index if not exists task_jobs_persona_status_idx
  on task_jobs(persona_id, status);
create index if not exists task_jobs_task_created_idx
  on task_jobs(task_id, created_at desc);
create index if not exists task_jobs_owner_created_idx
  on task_jobs(owner_id, created_at desc);

-- Touch updated_at on every update so callers can poll for changes.
create or replace function public.touch_task_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists task_jobs_touch_updated on task_jobs;
create trigger task_jobs_touch_updated
  before update on task_jobs
  for each row execute function public.touch_task_jobs_updated_at();

alter table task_jobs enable row level security;

drop policy if exists "owner read task_jobs"  on task_jobs;
drop policy if exists "owner write task_jobs" on task_jobs;

create policy "owner read task_jobs"  on task_jobs for select using (auth.uid() = owner_id);
create policy "owner write task_jobs" on task_jobs for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
