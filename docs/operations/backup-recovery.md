# Backup and recovery runbook

## Policy

- Enable managed Supabase daily backups and point-in-time recovery for production.
- Retain daily backups for 30 days and monthly recovery exports according to the organization's data-retention policy.
- Include Postgres, Auth users, and the private `task-artifacts` storage bucket. A database-only restore can leave artifact metadata and objects inconsistent.
- Encrypt exports with a separately managed recovery key and test restore access quarterly.

## Restore exercise

1. Record the incident time, current image digest, migration version, and latest known-good timestamp.
2. Disable worker dispatch and automatic merge.
3. Restore the chosen point into a new isolated project; never overwrite production during validation.
4. Apply only migrations belonging to the application image under test.
5. verify the schema compatibility probe, table counts, RLS tests, task/PR relationships, webhook ledger, job leases, and artifact downloads.
6. Run `pnpm smoke` against the isolated stack and inspect a representative completed task.
7. Cut over credentials and traffic using the provider's documented recovery procedure.
8. Rotate service-role, JWT, webhook, worker, provider, and encryption credentials if exposure is possible.
9. Re-enable dispatch first and automatic merge last, watching failure and lease-expiry metrics.

Document recovery-point loss and orphaned external GitHub side effects. GitHub PRs and merges are reconciled from webhooks/API state; they are never assumed rolled back with Postgres.
