-- Per-task runtime selection. Required when a task is assigned for
-- execution; nullable until then so the autoplan / backlog states stay
-- valid. The runtime drives which adapter (codex / claude_code) the
-- worker uses for plan & implement steps.

alter table tasks
  add column if not exists runtime text
    check (runtime in ('codex','claude_code'));

-- Idempotency-key dedupe table for mutating API requests. Maps a caller-
-- supplied key + owner to a task_job id (or response payload) so retries
-- collapse to a single durable record.

create table if not exists api_idempotency_keys (
  key text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,                    -- e.g. 'task_jobs.create', 'tasks.create'
  resource_id text,                       -- id of created resource (job id, task id…)
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_id, key, scope)
);

create index if not exists api_idempotency_keys_created_idx
  on api_idempotency_keys(created_at);

alter table api_idempotency_keys enable row level security;

drop policy if exists "owner read api_idempotency_keys"  on api_idempotency_keys;
drop policy if exists "owner write api_idempotency_keys" on api_idempotency_keys;

create policy "owner read api_idempotency_keys"
  on api_idempotency_keys for select using (auth.uid() = owner_id);
create policy "owner write api_idempotency_keys"
  on api_idempotency_keys for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
