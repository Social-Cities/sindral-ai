# Worker upgrade and rollback

1. Set `SINDRAL_JOB_DISPATCH_ENABLED=false` so no new work is leased.
2. Wait for running jobs to finish, or stop the worker gracefully so it drains and reports offline. Do not delete an active worktree.
3. Verify the release checksum/signature and review its required `WORKER_PROTOCOL_VERSION`, Node version, Git/`gh`, Claude/Codex capabilities, and configuration changes.
4. Install the versioned artifact, run `sindral-worker --version`, and start one canary worker.
5. Re-enable dispatch and run a non-code task, a sandbox code task, feedback, rebase, and (when allowed) merge. Watch lease expiry and validation failures.
6. Roll out remaining workers. Revoke superseded worker keys if hosts or operators changed.

An incompatible worker receives HTTP 426 and exits without registering. Roll back by stopping it, installing the previous immutable artifact, and restarting with the same worker identity/key if that key remains trusted. Local cleanup is a separate post-upgrade action and must start with `clean --dry-run`.
