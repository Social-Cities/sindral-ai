-- task_job_events: append-only audit trail of dispatch / orchestration /
-- runtime / git / github events for every job. Workers stream into this
-- table at every meaningful state transition; operators replay it to
-- diagnose stuck/failed jobs.

create table if not exists task_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references task_jobs(id) on delete cascade,
  task_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists task_job_events_job_idx
  on task_job_events(job_id, created_at asc);
create index if not exists task_job_events_task_idx
  on task_job_events(task_id, created_at asc);

alter table task_job_events enable row level security;

drop policy if exists "owner read task_job_events"  on task_job_events;
drop policy if exists "owner write task_job_events" on task_job_events;

create policy "owner read task_job_events"  on task_job_events for select using (auth.uid() = owner_id);
create policy "owner write task_job_events" on task_job_events for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
