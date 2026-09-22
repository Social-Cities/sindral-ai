# Sindral AI

Sindral AI is a software-development portal that takes a task (a Jira/Linear/GitHub ticket, an uploaded markdown plan, or free text) and drives it through the full SDLC with AI agents: planning, human plan review, implementation, adversarial review, verification, human review and merge. Agents run on **your own machine** through a lightweight worker; the central server orchestrates state, stores everything in Supabase and serves the web UI.

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the architecture and [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Repository layout

```
packages/shared   Domain types, workflow state machine, bundled workflows, zod schemas, agent protocol
apps/server       Fastify API + orchestrator (serves the built UI, SSE live updates, worker API)
apps/web          React 19 + Vite + Tailwind v4 UI
apps/worker       Node daemon that runs Claude Code / Codex agents in git worktrees and opens PRs
supabase          Database migrations (RLS on every table) and local config
```

## Prerequisites

- Node 22+ and pnpm 10 (`corepack enable`)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (local dev) or a hosted Supabase project
- On the worker machine: `git`, `gh` (GitHub CLI), and the `claude` and/or `codex` CLIs, authenticated

## Quick start (local)

```bash
pnpm install
pnpm --filter @sindral/shared build

# 1. Database
supabase start                      # prints API URL, anon key, service role key, JWT secret
#   local API runs on http://127.0.0.1:55321 and Studio on 55323 (see supabase/config.toml)
# migrations in supabase/migrations are applied automatically on start; later use `supabase db reset`

# 2. Environment
cp .env.example .env
#   fill SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET from `supabase status`
#   SECRETS_ENCRYPTION_KEY=$(openssl rand -hex 32)
#   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (same values as above), VITE_API_URL=http://localhost:8787

# 3. Server + web (two processes, or `pnpm dev` for both)
pnpm dev:server                     # http://localhost:8787
pnpm dev:web                        # http://localhost:5173 (proxies /api to the server)
```

Sign up in the UI, then open **Settings**:

1. For production, configure `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATIONS` (a JSON map from Sindral user UUIDs to installation IDs); the server mints repository-scoped installation tokens only for the matching tenant's jobs. A saved fine-grained PAT remains available for local/internal use and is encrypted at rest.
2. Create a **worker key**. Copy the one-time secret.

Start the worker on the machine that has your repos, `git`, `gh` and the agent CLIs:

```bash
SINDRAL_SERVER_URL=http://localhost:8787 SINDRAL_WORKER_KEY=sk_sindral_... pnpm dev:worker
```

Create a task on the Home page (pick repositories and a workflow), click **Start Planning**, review the plan in the task's Chat/Summary tabs, approve it, and watch the implement → adversarial review → verify → in-review pipeline produce one PR per repository. **Accept & merge** dispatches an ordered merge job; the task reaches `done` only after GitHub confirms every PR is merged.

### GitHub comments as feedback

Point a GitHub webhook (`issue_comment`, `pull_request_review_comment`, `pull_request`, JSON, secret = `GITHUB_WEBHOOK_SECRET`) at `https://<server>/api/webhooks/github`. GitHub's standard `X-GitHub-Delivery` header is required and durably deduplicated. Comments on PRs opened by Sindral become chat messages on the task; when the task is waiting for review they trigger an implement-feedback cycle. The worker replies directly to review-comment threads and links ordinary PR comments from its PR-level response; job markers prevent duplicate replies after retries. Pull-request events reconcile manual close/merge state.

## Production

```bash
pnpm build            # builds shared, server, web (dist served by the server) and worker
cd apps/server && node dist/index.js
```

Run the server behind TLS. Use a hosted Supabase project, apply migrations with `supabase db push`, set `SINDRAL_ENV=production`, and set `WEB_ORIGIN` to the exact HTTPS origin of the UI. Configure Supabase Auth providers (email/password or GitHub OAuth) in the Supabase dashboard. The server refuses to listen when it cannot reach Supabase, the schema version is incompatible, production origins are not HTTPS, or the production webhook secret is missing/weak.

Production merge is deliberately opt-in: set `SINDRAL_AUTO_MERGE_ENABLED=true` only after validating the GitHub App and repository allow-list. `SINDRAL_JOB_DISPATCH_ENABLED=false` is the emergency stop for new worker leases; queued jobs and read/review access remain intact until it is re-enabled. Disabling automatic merge also prevents already-queued merge jobs from being leased.

Operational procedures live in [`docs/operations`](docs/operations/deployment.md): deployment and staged rollout, backup/restore, incident response, secret rotation, retention/deletion, and worker upgrades.

## Scripts

| Command | What it does |
|---|---|
| `pnpm typecheck` | strict TypeScript in every package |
| `pnpm test` | vitest in every package |
| `pnpm lint` | eslint (typescript-eslint) |
| `pnpm build` | production builds |
| `pnpm bundle:check` | enforce compressed route, vendor, CSS, and total web bundle budgets |
| `pnpm db:reset` | recreate the local database from migrations |
| `pnpm db:test` | run pgTAP transaction, idempotency, and RLS tests against local Supabase |
| `pnpm db:lint` | lint the local Postgres schema |
| `pnpm smoke` | live end-to-end check against a running server + Supabase (see `scripts/smoke.mjs`) |

The smoke test drives the real stack: sign-up, task creation, the plan → feedback → approve →
subtask flow, worker job claiming and fencing, tenant isolation, webhook HMAC, and Postgres
row-level security. Run it after schema or orchestrator changes:

```bash
SMOKE_ANON_KEY=<anon key> SMOKE_WEBHOOK_SECRET=<GITHUB_WEBHOOK_SECRET> pnpm smoke
```

## Workflows

Four bundled workflows are seeded per user: **Full SDLC** (default), **Planning Only**, **Fast Track** and **Document (non-code)**. The Workflows page is a graph editor: steps are `human` gates, `agent` steps (engine, model, prompt with `{{task_description}}`/`{{plan}}`/`{{feedback}}` tokens, tools, permissions, output kind) or `end`. Edges carry events; a `feedback` edge on a human gate is triggered by chat. Tasks pin a snapshot of their workflow when they start, so editing a workflow never breaks an in-flight task.

Large tasks are split by the planning agent into ordered subtasks with their own PRs. Subtasks run serially, each planned just-in-time with the outcome of the previous one, and the worker rebases later branches in the stack when an earlier one changes.
