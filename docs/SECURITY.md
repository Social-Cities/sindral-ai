# Security notes

## Trust boundaries

| Actor | Authenticates with | Can reach |
|---|---|---|
| Browser (web UI) | Supabase Auth JWT (`Authorization: Bearer`) | `/api/*` user routes, scoped to `auth.uid()` |
| Worker daemon | Per-user API key `sk_sindral_…` (SHA-256 hash stored) | `/api/worker/*` only, scoped to the key's user |
| GitHub | HMAC-SHA256 (`X-Hub-Signature-256`) | `/api/webhooks/github` only |
| Server | Supabase service-role key (never shipped to clients) | Postgres |

Every repository call is scoped by the authenticated user id. Supabase RLS is enabled on every table (owner-only `select` for the UI; no client policies at all for `user_secrets`, `worker_keys`, `jobs` writes). Server-side functions (`claim_jobs`, `next_task_number`) are `security definer` and revoked from `anon`/`authenticated`.

## Secrets

- Provider tokens (GitHub, Linear, Jira) are encrypted with AES-256-GCM under `SECRETS_ENCRYPTION_KEY`; only a 4-character hint is ever returned to the UI.
- Worker keys are shown once at creation and stored hashed. Revocation is immediate.
- The current internal-deployment credential is an encrypted, repository-scoped fine-grained GitHub PAT handed to the worker inside a matching job dispatch over TLS. It is used for `git`/`gh` via an HTTP extra header / `GH_TOKEN`, never written to `.git/config`, never passed to the agent subprocess, and redacted from logs. Production automatic merge requires short-lived GitHub App installation tokens.
- Logs redact `authorization` headers and token fields.

## OWASP Top 10 mapping

- **A01 Broken access control** – user scoping in every query, RLS, worker key ↔ user binding, cross-user 404s.
- **A02 Cryptographic failures** – AES-256-GCM at rest, hashed API keys, TLS in production, no secrets in URLs.
- **A03 Injection** – zod validation on all input, parameterised Supabase queries, agent CLIs invoked with argv arrays (no shell), path/ref sanitisation in the worker, markdown rendered without raw HTML.
- **A04 Insecure design** – human gates in every bundled workflow, workflow pinning, PR creation always by the worker (agents cannot push).
- **A05 Security misconfiguration** – Helmet CSP, strict CORS, rate limiting, `.env` ignored, no stack traces to clients.
- **A06 Vulnerable components** – pinned versions, `pnpm audit` in CI.
- **A07 Identification & auth failures** – Supabase Auth, JWT verification (JWKS or HS256), constant-time comparisons, key revocation.
- **A08 Integrity failures** – webhook HMAC, worker results validated with schemas before any state change, tasks pinned to workflow snapshots.
- **A09 Logging failures** – structured pino logs, task event audit trail, job logs.
- **A10 SSRF** – ticket import only fetches exact allow-listed provider hosts parsed from the URL; GitHub diff fetch only for `github.com/<owner>/<repo>/pull/<n>`.

## Agent sandboxing

Agent steps declare `tools` and `permissions`. The worker maps them to CLI allow-lists (`--allowedTools`, `--permission-mode`, `--sandbox`). Read-only steps (planning, review) cannot edit files or run commands. Every code task runs in its own git worktree under `~/.sindral`, so concurrent tasks never share a working tree.
