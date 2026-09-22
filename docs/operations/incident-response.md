# Incident response runbook

## Immediate containment

1. Set `SINDRAL_JOB_DISPATCH_ENABLED=false` and `SINDRAL_AUTO_MERGE_ENABLED=false`; restart or roll the server so no new leases or merges are issued.
2. Revoke affected worker keys and provider credentials. If signing or database credentials may be exposed, rotate them from the provider side first.
3. Preserve application logs, task events, webhook delivery IDs, job IDs, image digest, database timeline, and relevant GitHub audit events. Never copy secret values into the incident channel.
4. Determine whether any claimed/running job still has a live lease. Stop its worker before changing repository branches.

## Investigation and recovery

- Scope affected users, tasks, repositories, PRs, artifacts, and time ranges by IDs and structured metadata, not by dumping content.
- Reconcile remote GitHub PR/merge state before retrying jobs. Never replay a merge blindly.
- For database corruption or deletion, follow [backup-recovery.md](backup-recovery.md).
- For credential exposure, follow [key-rotation.md](key-rotation.md).
- Use task retry only after the root cause is fixed; idempotency and lease checks protect retries but do not authorize repeated external side effects.

## Exit criteria

Complete a written timeline, affected-data assessment, credential-rotation record, recovery verification, and preventive actions. Restore dispatch in a sandbox first. Restore automatic merge only after confirmed head-SHA and branch-protection checks succeed.
