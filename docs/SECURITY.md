# Security notes

## Trust boundaries

| Actor | Authenticates with | Can reach |
|---|---|---|
| Browser (web UI) | Supabase Auth JWT (`Authorization: Bearer`) | `/api/*` user routes, scoped to `auth.uid()` |
| Worker daemon | Per-user API key `sk_sindral_…` (SHA-256 hash stored) | `/api/worker/*` only, scoped to the key's user |
| GitHub | HMAC-SHA256 (`X-Hub-Signature-256`) | `/api/webhooks/github` only |
| Server | Supabase service-role key (never shipped to clients) | Postgres |

Every repository call is scoped by the authenticated user id. Supabase RLS is enabled on every table (owner-only `select` for the UI; no client policies at all for `user_secrets`, `worker_keys`, or operational writes). Browser reads of `jobs` are also column-scoped so worker lease and outcome capability tokens remain service-role-only even through direct PostgREST queries. Server-side functions (`claim_jobs`, `renew_job_leases`, `activate_job_lease`, `next_task_number`, `apply_task_transition`, and the job-outcome/webhook-delivery lease functions) are `security definer` and revoked from `anon`/`authenticated`. Each privileged orchestration function fixes an empty `search_path`; transition and outcome functions also verify ownership plus task version or an unexpired per-claim lease token before recording state. The global webhook-delivery ledger contains hashes and responses but no user content, and is accessible only to the service role.

Worker routes authenticate the worker key before checking an exact wire-protocol header on every request. Missing or incompatible protocols receive HTTP 426 before handler state changes, including for workers that were already running during a server upgrade.

## Secrets

- Provider tokens (GitHub, Linear, Jira) are encrypted with AES-256-GCM under `SECRETS_ENCRYPTION_KEY`; only a 4-character hint is ever returned to the UI.
- Worker keys are shown once at creation and stored hashed. Revocation is immediate.
- Production uses short-lived GitHub App installation tokens minted per job, restricted to that job's repositories, and selected from a Sindral-user-to-installation mapping. Internal deployments may use an encrypted, repository-scoped fine-grained PAT; PAT-backed merge is disabled unless the worker explicitly sets `SINDRAL_ALLOW_PAT_MERGE=true`. Tokens are used for `git`/`gh` via an HTTP extra header / `GH_TOKEN`, never written to `.git/config`, never passed to the agent subprocess, and redacted from logs.
- Logs redact `authorization` headers, provider tokens, worker keys, and job lease capabilities.
- GitHub feedback references persist only the public PR/comment URLs, comment identifier, and comment kind. Worker replies carry a job-specific hidden marker so retries can detect an already-posted response before creating another external side effect.

## OWASP Top 10 mapping

- **A01 Broken access control** – user scoping in every query, RLS, worker key ↔ user binding, cross-user 404s.
- **A02 Cryptographic failures** – AES-256-GCM at rest, hashed API keys, TLS in production, no secrets in URLs.
- **A03 Injection** – zod validation on all input, parameterised Supabase queries, agent CLIs invoked with argv arrays (no shell), path/ref sanitisation in the worker, markdown rendered without raw HTML.
- **A04 Insecure design** – human gates in every bundled workflow, workflow pinning, PR creation always by the worker (agents cannot push).
- **A05 Security misconfiguration** – Helmet CSP, strict CORS, rate limiting, `.env` ignored, no stack traces to clients.
- **A06 Vulnerable components** – pinned versions, `pnpm audit` in CI, weekly CodeQL security-extended analysis, full-history Gitleaks scanning, and an OWASP ZAP baseline against the production bundle.
- **A07 Identification & auth failures** – Supabase Auth, JWT verification (JWKS or HS256), constant-time comparisons, key revocation.
- **A08 Integrity failures** – webhook HMAC plus delivery-ID/payload-hash replay fencing, worker results validated with schemas and fenced by durable outcome hashes/leases before effects are applied, tasks pinned to workflow snapshots.
- **A09 Logging failures** – structured pino logs, task event audit trail, job logs.
- **A10 SSRF** – ticket import only fetches exact allow-listed provider hosts parsed from the URL, refuses redirects, requires JSON, and streams through a one-MiB response cap; GitHub diff fetch only for `github.com/<owner>/<repo>/pull/<n>`.

## Agent execution

Agent steps declare `tools` and `permissions`, but the local worker treats those fields as orchestration intent rather than a filesystem sandbox. Agent subprocesses run with open local permissions inside Sindral-managed checkouts so required result files, artifacts, diagnostics and recovery work are not blocked by CLI sandbox policy. Non-write steps are still instructed not to modify repository files, commit, push or open pull requests; the worker validates structured results and performs GitHub publishing itself. Every code task runs in its own git worktree under `~/.sindral`, so concurrent tasks never share a working tree.
