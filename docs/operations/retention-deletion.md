# Retention and deletion runbook

- Task deletion cascades database-owned messages, events, jobs, logs, repository/PR records, and artifact metadata. Private storage deletion is durably queued; monitor the deletion queue until the object is gone.
- Worker `clean --dry-run` reports inactive worktrees, temp directories, results, outputs, and logs older than `SINDRAL_RETENTION_DAYS`. Real cleanup refuses an online worker or any active lease. Repository clones are retained caches and may be removed manually only while the worker is stopped.
- Production database, log, backup, and artifact retention must match the published customer policy. Legal holds override automated deletion and must be recorded.
- Before honoring an account-erasure request, disable/revoke its workers, wait for leases to expire, delete tasks and credentials, verify private objects are gone, and record when backups will age out.
- Structured logs should retain identifiers and outcomes, not task content or secrets. Restrict access and expire them on the operational log-retention schedule.
