-- task_conversations: durable chat between humans and the assigned persona
-- on a given task. Channel == 'plan' is the planning chat; 'implementation'
-- is the post-assignment / PR chat. position is monotonic per (task,
-- channel) so clients can paginate / sync without timestamps.

create table if not exists task_conversations (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references tasks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  from_id text not null,
  from_kind text not null check (from_kind in ('human','persona','system')),
  channel text not null check (channel in ('plan','implementation')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  position bigint not null,
  created_at timestamptz not null default now(),
  unique (task_id, channel, position)
);

create index if not exists task_conversations_task_channel_idx
  on task_conversations(task_id, channel, position);
create index if not exists task_conversations_owner_created_idx
  on task_conversations(owner_id, created_at desc);

alter table task_conversations enable row level security;

drop policy if exists "owner read task_conversations"  on task_conversations;
drop policy if exists "owner write task_conversations" on task_conversations;

create policy "owner read task_conversations"  on task_conversations for select using (auth.uid() = owner_id);
create policy "owner write task_conversations" on task_conversations for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
