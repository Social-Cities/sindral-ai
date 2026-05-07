-- Per-teammate work queue. When two tasks pick the same agent, the second
-- waits in this list until the first releases the slot. The agent queue
-- workflow in agatha-teams-workers owns this column — it writes the current
-- holder into task_id and the pending requests into queue.

alter table teammates
  add column if not exists queue jsonb not null default '[]'::jsonb;
