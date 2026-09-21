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

1. Save a GitHub token (fine-grained PAT with `contents:write`, `pull_requests:write` on the repos you want agents to work on). It is encrypted at rest and only handed to your worker. PATs are the local/internal deployment credential; production automatic merge requires the planned GitHub App installation-token flow.
2. Create a **worker key**. Copy the one-time secret.

Start the worker on the machine that has your repos, `git`, `gh` and the agent CLIs:

```bash
SINDRAL_SERVER_URL=http://localhost:8787 SINDRAL_WORKER_KEY=sk_sindral_... pnpm dev:worker
```

Create a task on the Home page (pick repositories and a workflow), click **Start Planning**, review the plan in the task's Chat/Summary tabs, approve it, and watch the implement → adversarial review → verify → in-review pipeline produce a PR. In the current baseline, **Accept** records approval but does not merge the PR; explicit verified merge is implemented in the production plan.

### GitHub comments as feedback

Point a GitHub webhook (`issue_comment`, `pull_request_review_comment`, JSON, secret = `GITHUB_WEBHOOK_SECRET`) at `https://<server>/api/webhooks/github`. Comments on PRs opened by Sindral become chat messages on the task; when the task is waiting for review they trigger an implement-feedback cycle and the worker replies on the PR.

## Production

```bash
pnpm build            # builds shared, server, web (dist served by the server) and worker
cd apps/server && node dist/index.js
```

Run the server behind TLS. Use a hosted Supabase project, apply migrations with `supabase db push`, and set `WEB_ORIGIN` to the public origin of the UI. Configure Supabase Auth providers (email/password or GitHub OAuth) in the Supabase dashboard.

## Scripts

| Command | What it does |
|---|---|
| `pnpm typecheck` | strict TypeScript in every package |
| `pnpm test` | vitest in every package |
| `pnpm lint` | eslint (typescript-eslint) |
| `pnpm build` | production builds |
| `pnpm db:reset` | recreate the local database from migrations |

## Workflows

Four bundled workflows are seeded per user: **Full SDLC** (default), **Planning Only**, **Fast Track** and **Document (non-code)**. The Workflows page is a graph editor: steps are `human` gates, `agent` steps (engine, model, prompt with `{{task_description}}`/`{{plan}}`/`{{feedback}}` tokens, tools, permissions, output kind) or `end`. Edges carry events; a `feedback` edge on a human gate is triggered by chat. Tasks pin a snapshot of their workflow when they start, so editing a workflow never breaks an in-flight task.

Large tasks are split by the planning agent into ordered subtasks with their own PRs. Subtasks run serially, each planned just-in-time with the outcome of the previous one, and the worker rebases later branches in the stack when an earlier one changes.
