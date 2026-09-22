-- Apply browser-role privilege hardening as a forward migration so databases
-- that already ran the initial schema receive the same protection as new ones.
-- RLS remains the primary authorization boundary; these revocations are defense
-- in depth against a future policy mistake.
revoke all on
  public.user_secrets,
  public.worker_keys,
  public.idempotency_keys,
  public.webhook_deliveries,
  public.artifact_storage_deletions
  from anon, authenticated;

revoke insert, update, delete on
  public.workers,
  public.workflows,
  public.tasks,
  public.task_messages,
  public.task_events,
  public.task_artifacts,
  public.jobs,
  public.job_logs,
  public.task_repositories,
  public.pull_requests
  from anon, authenticated;
