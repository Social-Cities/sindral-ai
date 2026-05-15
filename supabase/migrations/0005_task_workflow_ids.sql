-- Track the Temporal workflow that drives each task. workflow_id is the
-- canonical id (typically `task:<task_id>`) and workflow_run_id changes on
-- every restart — useful for debugging and for correlating worker logs back
-- to a task. Both are nullable because tasks created before workflows were
-- enabled (or with WORKFLOWS_ENABLED=false) won't have one.

alter table tasks add column if not exists workflow_id text;
alter table tasks add column if not exists workflow_run_id text;

create index if not exists tasks_workflow_id_idx on tasks(workflow_id);
