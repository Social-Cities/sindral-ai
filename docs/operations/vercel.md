# Deploy the portal and API on Vercel

The root `vercel.json` deploys the Vite frontend and a single Node.js API function
from this monorepo. Hosted Supabase stores application state, authentication, and
artifacts. Agent workers continue running on your own machines, including a Mac
Mini; they make outbound HTTPS connections to the deployment.

## Project settings

Import the repository into Vercel with the repository root as the Root Directory
and Node.js 22.x or 24.x. The checked-in configuration selects Vite, installs with
`pnpm install --frozen-lockfile`, runs `pnpm build:vercel`, and publishes
`apps/web/dist`. The build compiles shared types and the server before Vercel
traces `api/handler.mjs` and its imports. The standalone worker is not bundled.

The API is a Node.js function, not an Edge function. Its maximum duration is 300
seconds. `NODEJS_HELPERS=0` is supplied in `vercel.json`: keep it disabled so
Fastify receives the original request stream, especially for GitHub HMAC checks.
The entry point does not bind a port, install signal handlers, or exit the process.
It initializes once per warm instance, checks the database schema, and retries
initialization on a later request if a cold start fails.

Vercel disables Node's experimental `require(ESM)` support. Static-file serving
dependencies are loaded only by the standalone server, so the API does not depend
on that feature. `pnpm check:vercel` imports the compiled function with the same
restriction; both CI and `pnpm build:vercel` run this check after building.

## Environment and database

Use separate hosted Supabase projects for production and staging/preview work.
Follow [the setup guide](../SETUP_AND_DEPLOYMENT.md#4-create-hosted-supabase-environments)
to review and apply all migrations, including
`20261024173119_vercel_maintenance_lease.sql`, before deploying this version. The
server checks the exact schema version, so migrate and replace older servers as
one coordinated rollout. The new table and RPCs are accessible only to the service
role; browser roles cannot acquire or release maintenance leases.

Set these Vercel environment variables for each intended deployment environment:

| Variable | Value |
|---|---|
| `SINDRAL_ENV` | `production` |
| `SUPABASE_URL` | Hosted project HTTPS URL |
| `SUPABASE_ANON_KEY` | Project publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only project secret key |
| `SUPABASE_JWT_SECRET` | Empty for ES256/RS256; legacy HS256 secret if applicable |
| `SECRETS_ENCRYPTION_KEY` | Existing 64-character hex encryption key, or a fresh one for a new installation |
| `GITHUB_WEBHOOK_SECRET` | At least 32 random characters |
| `METRICS_TOKEN` | Separate random secret, at least 32 characters |
| `CRON_SECRET` | Separate random secret, at least 32 characters |
| `NODEJS_HELPERS` | `0` for builds and runtime (also supplied by `vercel.json`) |
| `WEB_ORIGIN` | Exact HTTPS frontend origin; comma-separated for intentional additional origins |
| `VITE_SUPABASE_URL` | Same hosted project HTTPS URL |
| `VITE_SUPABASE_ANON_KEY` | Same browser-safe publishable key |
| `VITE_API_URL` | Empty for this combined frontend/API deployment |
| `SINDRAL_JOB_DISPATCH_ENABLED` | `true` when ready to lease jobs |
| `SINDRAL_AUTO_MERGE_ENABLED` | `false` initially |

Configure the optional GitHub OAuth/App and APNs settings from `.env.example` as
needed. Set `GITHUB_OAUTH_CALLBACK_URL` and the GitHub OAuth App callback to
`https://<your-domain>/api/github/callback`. Set GitHub's webhook target to
`https://<your-domain>/api/webhooks/github`. Set the Supabase Auth Site URL and
allowed redirect URLs to the frontend origin. Rebuild after changing `VITE_*`
values. Never copy server secrets into a `VITE_*` variable.

The Vercel entry point selects `SINDRAL_RUNTIME=vercel` automatically. Local
`pnpm dev` and Docker use the default `server` runtime. To exercise Vercel behavior
without deploying, set `SINDRAL_RUNTIME=vercel` and `CRON_SECRET` when running the
Node server. A hosted production environment still requires the other production
settings above.

## Recovery schedule

`GET /api/cron/sweep` requires `Authorization: Bearer <CRON_SECRET>`. Vercel Cron
adds that header automatically. The checked-in schedule calls it once per minute.
It requeues expired worker leases and resumes abandoned durable outcomes, awaiting
all work before responding. A database lease prevents overlapping sweeps, including
across instances. The sweep stops starting new jobs after four minutes; its lease
expires after six minutes if Vercel terminates the invocation. Later calls resume
remaining work. Monitor failures because Vercel does not retry a failed cron call.

The per-minute schedule requires **Vercel Pro or Enterprise**. For Hobby, remove
the `crons` array and arrange a trusted external scheduler to call the same endpoint
every minute with its bearer token. A once-daily recovery schedule is insufficient
for the worker's short leases. Vercel Cron runs against production deployments;
preview deployments need an explicit external scheduler if testing recovery.
See [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) and
[cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).

## Live updates and operational limits

Vercel instances do not share the in-memory event hub. In Vercel mode,
`/api/events` sends a `sync` signal immediately and every five seconds. Web and iOS
clients use it to refresh authenticated state from the API. Each stream ends after
55 seconds so clients reconnect and reauthenticate well before the function
deadline. Task creation, changes, deletion, job logs, and worker status therefore
remain visible when mutations land on a different instance, with up to roughly
five seconds of refresh latency. No event-history table or external message broker
is needed. Only the persistent-server runtime uses the background sweep timer.

Function requests have a platform payload limit. The Vercel runtime accepts up to
4 MiB per request, including the complete worker result and all its inline
artifacts; the persistent server retains its 16 MiB limit. Individual artifacts
still have the shared 1,000,000-byte limit. Large combined results need splitting
or a future direct-to-storage upload flow. Responses must also fit Vercel's
[payload limits](https://vercel.com/docs/functions/limitations#request-body-size).

Fastify rate limits and event counters are per instance. Configure Vercel Firewall
rules for deployment-wide limits and use platform logs/observability for aggregate
request counts. `/api/metrics` still returns database-backed operational gauges,
but its in-memory counters are not deployment-wide totals.

If Vercel Deployment Protection is enabled, explicitly arrange access for workers,
GitHub webhooks, mobile clients, and any external scheduler. A Vercel login page
prevents those clients from reaching Sindral's bearer-token/HMAC authentication.

## Verify and connect the worker

Check `/api/health`, sign in, create a task, and refresh a nested task URL to verify
SPA routing. Confirm an unknown `/api/*` URL returns JSON 404 rather than HTML.
Check an unauthenticated `/api/cron/sweep` returns 401 and that a configured cron
run succeeds. Confirm GitHub webhook delivery and OAuth callback behavior.

Set the Mac Mini worker's `SINDRAL_SERVER_URL=https://<your-domain>` and use its
existing worker key. With the portal open, run a task and confirm progress and logs
refresh across SSE reconnections. Exercise recovery in a staging project before
enabling automatic merge. Keep using the same release for workers and server.
