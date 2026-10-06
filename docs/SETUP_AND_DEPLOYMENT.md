# Setup and deployment guide

This guide takes Sindral AI from a fresh checkout to a working local stack, then to a hosted Supabase deployment with a production server and one or more developer-machine workers.

The instructions were checked against Supabase CLI 2.117.0 and the Supabase documentation on 2026-09-23. Supabase now recommends publishable (`sb_publishable_...`) and secret (`sb_secret_...`) API keys; its legacy `anon` and `service_role` keys are being deprecated. Sindral's environment-variable names retain `ANON_KEY` and `SERVICE_ROLE_KEY` for compatibility, but they accept the new key types.

## 1. Understand the pieces

You will run three components:

1. **Supabase** — Postgres, authentication, and private artifact storage.
2. **Sindral server** — the Fastify API, workflow orchestrator, event stream, and compiled web UI. One container serves both the UI and `/api/*` on port 8787.
3. **Sindral worker** — a daemon on a developer-controlled machine with Git, GitHub CLI, and Claude Code and/or Codex installed. It makes outbound connections only.

For local development, Supabase runs in Docker and the server/web run as Node processes. For production, use a hosted Supabase project and deploy the repository's Docker image behind HTTPS.

## 2. Prerequisites

Install:

- Node.js 22 or later. Supabase client libraries no longer support Node 20.
- pnpm 10.34.3 through Corepack.
- Git.
- A Docker-compatible container runtime for local Supabase.
- Supabase CLI 2.117.0 or a compatible later stable release.
- On every worker host: GitHub CLI (`gh`) plus `claude`, `codex`, or both.

Confirm the toolchain:

```bash
node --version
corepack enable
corepack prepare pnpm@10.34.3 --activate
pnpm --version
docker version
supabase --version
git --version
gh --version
```

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @sindral/shared build
```

## 3. Run everything locally

### 3.1 Start Supabase

The repository already contains `supabase/config.toml`; do not run `supabase init`.

```bash
supabase start
supabase status -o env
```

Sindral deliberately uses non-default local ports:

| Service | Local address |
|---|---|
| Supabase API | `http://127.0.0.1:55321` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:55322/postgres` |
| Studio | `http://127.0.0.1:55323` |

`supabase start` applies every migration automatically. To prove that the database can be recreated from source and that its security rules work:

```bash
pnpm db:reset
pnpm db:test
pnpm db:lint
```

### 3.2 Create the local environment file

```bash
cp .env.example .env
openssl rand -hex 32   # use this for SECRETS_ENCRYPTION_KEY
openssl rand -hex 32   # use a different value for GITHUB_WEBHOOK_SECRET
openssl rand -hex 32   # use another value for METRICS_TOKEN
```

Map the output of `supabase status -o env` into `.env`:

| `.env` setting | Local Supabase value |
|---|---|
| `SUPABASE_URL` | `API_URL` |
| `SUPABASE_ANON_KEY` | `PUBLISHABLE_KEY` (or legacy `ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | `SECRET_KEY` (or legacy `SERVICE_ROLE_KEY`) |
| `SUPABASE_JWT_SECRET` | `JWT_SECRET` for the local HS256 stack |
| `VITE_SUPABASE_URL` | `API_URL` |
| `VITE_SUPABASE_ANON_KEY` | `PUBLISHABLE_KEY` (or legacy `ANON_KEY`) |

Keep these local values:

```dotenv
SINDRAL_ENV=development
WEB_ORIGIN=http://localhost:5173
VITE_API_URL=http://localhost:8787
SINDRAL_JOB_DISPATCH_ENABLED=true
SINDRAL_AUTO_MERGE_ENABLED=false
```

The publishable key is expected in browser code. The secret key bypasses Row Level Security and must never appear in a `VITE_*` variable, browser bundle, log, or commit. `.env` is gitignored.

### 3.3 Start the portal

```bash
pnpm dev
```

Open `http://localhost:5173`. Local email confirmation is disabled, so you can create an account and sign in immediately. Local Supabase Studio is available at `http://127.0.0.1:55323`.

To connect GitHub locally, create a GitHub OAuth App whose callback is:

```text
http://localhost:5173/api/github/callback
```

Then set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `GITHUB_OAUTH_CALLBACK_URL` in `.env`. Keep GitHub disabled in Supabase Auth; email/password remains the app login method.

### 3.4 Configure GitHub for a local/internal run

The simplest local option is a fine-grained personal access token restricted to a disposable repository. Give it only the repository permissions Sindral needs:

- Contents: read and write
- Pull requests: read and write
- Issues: read and write (PR conversation comments use the Issues API)
- Metadata: read

In the portal, open **Settings → GitHub**, save the token, then create a worker key under **Settings → Worker keys**. The token is encrypted with `SECRETS_ENCRYPTION_KEY`; the worker key is shown only once.

PAT-backed automatic merging is disabled at both boundaries by default. For a disposable local sandbox only, enable it in both processes:

```dotenv
# Server
SINDRAL_AUTO_MERGE_ENABLED=true

# Worker
SINDRAL_ALLOW_PAT_MERGE=true
```

Keep both false when you only want Sindral to open PRs for manual review.

### 3.5 Start a worker

Authenticate the agent CLIs on the worker machine and confirm their availability:

```bash
claude --version
codex --version
gh --version
```

Put the one-time worker key into `.env`, or export it only in the worker terminal:

```bash
SINDRAL_SERVER_URL=http://localhost:8787 \
SINDRAL_WORKER_KEY=<generated-worker-key> \
pnpm dev:worker
```

The Home page should change from “No worker connected” to an online worker. A workflow step that selects an unavailable engine fails clearly, so install at least the engine used by your selected workflow.

### 3.6 Exercise the first task

1. Create a small task against a disposable repository.
2. Click **Start Planning**.
3. Review the plan, optionally send feedback, then approve it.
4. Watch implementation, adversarial review, and verification run on the worker.
5. Review the resulting PR. If automatic merge is enabled, use **Accept & merge**; the task becomes Done only after GitHub confirms the merge.

Run the live local smoke test while the server is running:

```bash
SMOKE_SUPABASE=http://127.0.0.1:55321 \
SMOKE_API=http://127.0.0.1:8787 \
SMOKE_ANON_KEY='<local publishable key>' \
SMOKE_WEBHOOK_SECRET='<same value as GITHUB_WEBHOOK_SECRET>' \
pnpm smoke
```

Stop the local stack without deleting its Docker volumes:

```bash
supabase stop
```

Use `supabase stop --no-backup` only when you intentionally want to discard the local database.

## 4. Create hosted Supabase environments

Use separate Supabase projects for staging and production. Do not test migrations, webhook replay, conflict handling, or automatic merge against the production project first.

For each project:

1. Create the project in the Supabase Dashboard and record its project reference and database password.
2. In the project's **Connect** dialog or **Settings → API Keys**, create/copy:
   - Project URL: `https://<project-ref>.supabase.co`
   - Publishable key: `sb_publishable_...`
   - Secret key: `sb_secret_...`
3. Put the secret key only in the server's secret manager. It bypasses RLS.
4. Leave `SUPABASE_JWT_SECRET` empty for current projects using asymmetric ES256/RS256 signing. Sindral verifies those tokens through the project's JWKS endpoint. Set it only for a legacy project that still issues HS256 tokens.

### 4.1 Apply the database migrations

The checked-in migrations are authoritative for a new Sindral project. Do not run `db pull` against the empty project.

```bash
supabase login
supabase link --project-ref '<project-ref>'
supabase db push --linked --dry-run
supabase db push --linked
supabase migration list
```

Review the dry run before applying it. Do not pass `--include-seed` in production; `supabase/seed.sql` is local-only and bundled workflows are created for each user by the server.

Repeat the process for staging and then production, explicitly relinking and checking the project reference each time. In CI, use protected secrets named `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_ID`; link and run `supabase db push` from an approval-protected deployment job.

After migration, open **Database → Advisors** (including the current service health advisors) and resolve unexpected security or performance findings. The repository's local equivalent is:

```bash
supabase db lint --local --level warning --fail-on warning
```

### 4.2 Configure Supabase Auth

Under **Authentication → URL Configuration**:

- Set **Site URL** to the exact production portal origin, such as `https://sindral.example.com`.
- Add the exact staging origin and any intentional preview origins to **Redirect URLs**.
- Prefer exact production URLs; reserve `/**` wildcards for controlled staging/preview hosts.

Under **Authentication → Providers**:

- Email/password is already supported by the UI. For hosted projects, email confirmation should remain enabled; configure custom SMTP for reliable production delivery.
- GitHub does not need to be enabled as a Supabase Auth provider. Sindral app accounts always authenticate through Supabase email/password.

Create a GitHub OAuth App for repository access after login. Set its authorization callback URL to `https://<portal-origin>/api/github/callback`, then configure `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and the same URL as `GITHUB_OAUTH_CALLBACK_URL`. For local development, use `http://localhost:5173/api/github/callback`; Vite proxies it to the API server. Sindral requests `repo read:org offline_access`, validates the connected GitHub account on the server, stores both tokens inside one encrypted credential, and rotates expiring access and refresh tokens automatically. Existing non-expiring OAuth tokens and PATs remain supported.

This GitHub OAuth App is separate from the GitHub App used to grant workers short-lived repository credentials.

### 4.3 Storage

No manual bucket creation is required. On the first large artifact operation, the server creates or secures a private `task-artifacts` bucket with the allowed MIME types and size limit. This requires the server's secret key. Confirm afterward that the bucket is private in Supabase Storage.

## 5. Configure the production GitHub App

Create a GitHub App for repository automation. Use these repository permissions:

- Contents: read and write
- Pull requests: read and write
- Issues: read and write
- Metadata: read-only

Subscribe the app to:

- Issue comment
- Pull request
- Pull request review comment

Set its webhook URL to:

```text
https://<portal-origin>/api/webhooks/github
```

Generate a webhook secret of at least 32 random characters and use the identical value for the GitHub App and `GITHUB_WEBHOOK_SECRET`. Install the app only on allow-listed repositories.

Generate a private key for the app and record:

- GitHub App ID
- PEM private key
- Installation ID for each Sindral tenant
- The corresponding Sindral user UUID from **Supabase → Authentication → Users**

Build `GITHUB_APP_INSTALLATIONS` as a JSON object:

```json
{
  "11111111-1111-4111-8111-111111111111": 12345678
}
```

The private key may be stored as a multiline secret or with newlines escaped as `\n`. Do not store it in `.env` on shared hosts or commit it.

## 6. Build and deploy the server/UI image

The web application's Supabase URL and publishable key are public build-time values. The server's secret key is runtime-only.

If you use the repository's tag-triggered release workflow, first define these GitHub Actions **repository variables** (not secrets—the values are intentionally public): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`. A release build fails rather than silently shipping a browser bundle pointed at localhost when the first two are missing.

```bash
docker build --pull \
  --build-arg VITE_SUPABASE_URL='https://<project-ref>.supabase.co' \
  --build-arg VITE_SUPABASE_ANON_KEY='sb_publishable_...' \
  --build-arg VITE_API_URL='https://sindral.example.com' \
  --tag registry.example.com/sindral-ai:<git-sha> \
  .

docker push registry.example.com/sindral-ai:<git-sha>
```

Deploy that immutable tag or digest behind TLS and route the public hostname to container port 8787. Configure these runtime values in the hosting platform's secret/environment manager:

```dotenv
SINDRAL_ENV=production
HOST=0.0.0.0
PORT=8787
WEB_ORIGIN=https://sindral.example.com

SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
SUPABASE_JWT_SECRET=

SECRETS_ENCRYPTION_KEY=<64 hex characters>
GITHUB_WEBHOOK_SECRET=<32+ random characters>
GITHUB_OAUTH_CLIENT_ID=<oauth app client id>
GITHUB_OAUTH_CLIENT_SECRET=<oauth app client secret>
GITHUB_OAUTH_CALLBACK_URL=https://sindral.example.com/api/github/callback
GITHUB_APP_ID=<app id>
GITHUB_APP_PRIVATE_KEY=<PEM or escaped PEM>
GITHUB_APP_INSTALLATIONS={"<sindral-user-uuid>":<installation-id>}
METRICS_TOKEN=<32+ random characters>

SINDRAL_JOB_DISPATCH_ENABLED=false
SINDRAL_AUTO_MERGE_ENABLED=false
LOG_LEVEL=info
```

The `SUPABASE_ANON_KEY` runtime setting is currently required by configuration validation even though browser authentication uses the build-time value. Use the publishable key for it. Never pass `SUPABASE_SERVICE_ROLE_KEY` as a Docker build argument.

The server refuses to listen if production URLs are not HTTPS, secrets are too weak, Supabase is unreachable, or migrations do not match the server's expected schema.

Verify the initial deployment:

```bash
curl --fail https://sindral.example.com/api/health
curl --fail \
  -H "Authorization: Bearer $METRICS_TOKEN" \
  https://sindral.example.com/api/metrics
```

Then confirm in a browser that account creation/sign-in works and that the UI is using the hosted Supabase project rather than localhost.

## 7. Deploy production workers

Build the worker from the exact same tag as the server, or use the checksummed worker artifact produced by the release workflow:

```bash
pnpm release:worker
(cd release && shasum -a 256 -c sindral-worker-*.sha256)
```

Create a worker key in the deployed portal. On each controlled worker host, configure:

```dotenv
SINDRAL_SERVER_URL=https://sindral.example.com
SINDRAL_WORKER_KEY=sk_sindral_...
SINDRAL_WORKDIR=/absolute/path/to/sindral-worker-data
SINDRAL_CONCURRENCY=2
SINDRAL_WORKER_NAME=build-mac-01
SINDRAL_EXTRA_PATH=/opt/homebrew/bin:/usr/local/bin
SINDRAL_RETENTION_DAYS=7
SINDRAL_ALLOW_PAT_MERGE=false
LOG_LEVEL=info
```

Start it using the monorepo build:

```bash
pnpm --filter @sindral/shared build
pnpm --filter @sindral/worker build
pnpm --filter @sindral/worker start
```

Run it under a process supervisor appropriate to the host (for example, systemd or launchd), with automatic restart and logs sent to the host's protected logging system. The worker and server negotiate a protocol version; HTTP 426 means they must be upgraded together.

Supervisors often do not load the same shell startup files as SSH sessions. If
`codex`, `claude`, or `gh` works over SSH but the worker reports it missing, add
the install directories to `SINDRAL_EXTRA_PATH` or set `SINDRAL_CODEX_BIN`,
`SINDRAL_CLAUDE_BIN`, or `SINDRAL_GH_BIN` to absolute paths.

## 8. Safe rollout

Use this sequence:

1. Deploy migrations and the server with dispatch and automatic merge disabled.
2. Verify health, metrics, auth, RLS, Storage, and webhook signature handling.
3. Start a worker and set `SINDRAL_JOB_DISPATCH_ENABLED=true` for the staging deployment.
4. Keep automatic merge disabled while a sandbox task creates and updates a real PR.
5. Set `SINDRAL_AUTO_MERGE_ENABLED=true` only after GitHub App permissions, branch protection, checks, and repository allow-list behavior are confirmed.
6. Run the controlled staging smoke test described in [`operations/deployment.md`](operations/deployment.md).
7. Complete the external release gates in [`TRACEABILITY.md`](TRACEABILITY.md) before enabling production tenants.

The emergency controls are runtime server settings:

- `SINDRAL_JOB_DISPATCH_ENABLED=false` stops leasing new jobs while preserving read/review access.
- `SINDRAL_AUTO_MERGE_ENABLED=false` prevents merge jobs from being leased.

## 9. Verification before every release

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm bundle:check
pnpm test:e2e
pnpm db:reset
pnpm db:test
pnpm db:lint
pnpm audit --audit-level high
```

For hosted staging, retain the output of `pnpm smoke:staging` with the release record. Also retain the image digest, migration list, worker checksum/attestation, security scan URLs, restore-test record, and GitHub webhook delivery IDs.

## 10. Upgrades and rollback

- Apply only committed, forward-only migrations. Never edit a migration that has already reached an environment.
- Back up the hosted project and record a restore point before applying migrations.
- Deploy by immutable image digest.
- Roll back application code by redeploying the previous digest only when it remains compatible with the migrated schema.
- For database recovery, restore into an isolated Supabase project first and validate it before cutover; do not overwrite production as the first recovery step.
- Upgrade workers from the same release as the server. Disable dispatch, let active jobs finish, upgrade one worker, validate it, then continue the fleet.

See the runbooks for [deployment](operations/deployment.md), [backup and recovery](operations/backup-recovery.md), [monitoring](operations/monitoring.md), [incident response](operations/incident-response.md), [key rotation](operations/key-rotation.md), and [worker upgrades](operations/worker-upgrade.md).

## 11. Troubleshooting

### Server says the schema is incompatible

The server release is ahead of the database. Link the intended Supabase project, review `supabase db push --linked --dry-run`, apply the migrations, and restart the server. Confirm you did not link staging commands to production accidentally.

### Login redirects to the wrong host

Set the Supabase Auth Site URL to the portal's exact public origin and add that origin to Redirect URLs.

### GitHub authorization returns to the wrong host

Make `GITHUB_OAUTH_CALLBACK_URL` exactly match the callback URL configured on the GitHub OAuth App. It should be the portal origin followed by `/api/github/callback`.

### Login works locally but hosted API requests return 401

For a current asymmetric-signing project, leave `SUPABASE_JWT_SECRET` empty and make sure the server can reach `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. For a legacy HS256 project, configure its JWT secret on the server.

### Worker is offline or exits immediately

- HTTP 401: the worker key is wrong or revoked; create a new one.
- HTTP 426: server and worker protocol versions differ; upgrade them together.
- Missing engine warning: install/authenticate the selected `claude` or `codex` CLI, or change the workflow step's engine.
- No jobs claimed: verify the worker belongs to the same user, dispatch is enabled, and no older job for the same task owns an active lease.

### PR creation or comments fail

Check the GitHub App installation covers the repository and has Contents, Pull requests, Issues, and Metadata permissions. Confirm the user's UUID maps to the correct installation ID. Inspect worker logs for the bounded, redacted GitHub CLI error.

### A task stays in Merging

Automatic merge is probably disabled, required GitHub checks/reviews are incomplete, the PR head changed, or the GitHub App lacks merge permission. Do not bypass branch protection; inspect the task Steps tab and merge-failure metric.

### GitHub comments do not appear in the task

Confirm the webhook URL, identical webhook secret, subscribed events, and recent delivery response in GitHub. Sindral requires GitHub's delivery ID and ignores its own marked comments to prevent loops.

### Artifact upload/download fails

Confirm Supabase Storage is enabled and the server uses the secret key rather than the publishable key. Check that `task-artifacts` exists and is private. The server creates or repairs its bucket settings on demand.

## Official Supabase references

- [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Managing environments and migrations](https://supabase.com/docs/guides/deployment/managing-environments)
- [API keys](https://supabase.com/docs/guides/api/api-keys)
- [Auth redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [GitHub OAuth](https://supabase.com/docs/guides/auth/social-login/auth-github)
- [Supabase changelog](https://supabase.com/changelog)
