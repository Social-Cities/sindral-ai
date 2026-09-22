# Deployment and rollout

## Immutable server artifact

Build the server and web UI together from a tagged commit:

```bash
docker build --pull --tag registry.example.com/sindral-ai:<git-sha> .
docker push registry.example.com/sindral-ai:<git-sha>
```

Deploy by digest, not a mutable tag. Supply secrets through the platform secret manager; never bake `.env` into the image. The container runs as the unprivileged `node` user and serves both `/api/*` and the built SPA on port 8787.

Pushing a `v*` tag builds the image as `ghcr.io/<owner>/<repository>/server:<tag>` and `:<git-sha>`, then records signed GitHub provenance for the resulting digest. Verify it before deployment with `gh attestation verify oci://ghcr.io/<owner>/<repository>/server:<tag> -R <owner>/<repository>` and retain the resolved digest in the deployment record.

Before shifting traffic:

1. Back up the database and record the restore point.
2. Apply `supabase/migrations` from the same commit.
3. Start one container with `SINDRAL_JOB_DISPATCH_ENABLED=false`, `SINDRAL_AUTO_MERGE_ENABLED=false`, and a secret-manager-backed `METRICS_TOKEN`.
4. Confirm `/api/health`, startup schema compatibility, sign-in, read access, and webhook delivery.
5. Enable dispatch for an internal sandbox user. Keep automatic merge disabled and inspect the proposed merge evidence.
6. Enable automatic merge only for allow-listed sandbox repositories, then invited beta repositories.
7. Promote to general availability only after backup restore, incident, key-rotation, worker-revocation, and rollback exercises pass.

Rollback application code by redeploying the previous image digest. Database migrations are forward-only: restore to a disposable environment first, assess compatibility, and use a corrective migration unless incident response explicitly chooses point-in-time recovery.

## Worker release

Build and test the worker from the same tag as the server. The worker announces its package version and negotiates `WORKER_PROTOCOL_VERSION`; the server rejects incompatible clients with HTTP 426 before mutating worker state. Publish immutable checksummed artifacts only after the full verification suite. Upgrade workers using [worker-upgrade.md](worker-upgrade.md).
