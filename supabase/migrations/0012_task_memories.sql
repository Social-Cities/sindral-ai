-- task_memories: per-task agent memory rollup. One row per task, lazily
-- created on the first summarize. The rollup is a markdown blob authored
-- by a small/cheap model (default claude-haiku-4-5) that compresses the
-- task's history into a fixed-size context bundle. Recent verbatim turns
-- are NOT stored here — they're read from task_conversations / *_messages
-- at activity time. See sindral-ai-workers/src/db/memory.ts for the
-- read/write helpers and src/runtime/summarize.ts for the summarizer.
--
-- human_edited flips to true when the user PATCHes the rollup themselves
-- via /tasks/:id/memory. The summarizer respects edits by treating them
-- as the new baseline and only merging in events newer than human_edit_at.

create table if not exists task_memories (
  task_id text primary key references tasks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  rollup_markdown text not null default '',
  rollup_tokens int not null default 0,
  -- Highest task_conversations.position covered by the current rollup.
  -- -1 means "never summarized; rollup is empty/seed".
  last_summarized_position bigint not null default -1,
  last_summarized_at timestamptz,
  -- How many new events (chat + plan/pr msgs) have arrived since the last
  -- summarize. Used by the debounce policy in maybeSummarizeTaskMemory.
  unsummarized_count int not null default 0,
  -- Human-edit tracking. The rollup IS the editable surface; we just
  -- record whether the most recent write came from a human, so the
  -- summarizer can preserve their intent.
  human_edited boolean not null default false,
  human_edit_at timestamptz,
  -- Forward-compat: if we change rollup section structure, bump this so
  -- old prompts stay parseable.
  schema_version int not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists task_memories_owner_idx
  on task_memories(owner_id, updated_at desc);

create or replace function public.touch_task_memories_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists task_memories_touch_updated on task_memories;
create trigger task_memories_touch_updated
  before update on task_memories
  for each row execute function public.touch_task_memories_updated_at();

alter table task_memories enable row level security;

drop policy if exists "owner read task_memories"  on task_memories;
drop policy if exists "owner write task_memories" on task_memories;

create policy "owner read task_memories"  on task_memories for select using (auth.uid() = owner_id);
create policy "owner write task_memories" on task_memories for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
