# Sindral AI — Production Implementation Plan

## Plan summary

Build Sindral AI as a pnpm monorepo with a React/Vite portal, a Fastify orchestration API, Supabase/Postgres persistence, and a Node worker that runs Claude or Codex in isolated git worktrees. The repository already contains a functioning baseline for those four layers; implementation should proceed by preserving the Figma interaction model, closing the remaining domain and security gaps, validating the real Supabase/GitHub/worker integration, and releasing in small vertical slices. The production milestone is not reached until a task can move from intake through a confirmed merged pull request (or a completed non-code artifact), with tenant isolation, recoverable failures, and an auditable event trail.

## Inputs and precedence

1. `../sindral-ai-engineering.md` defines product behavior and acceptance criteria.
2. `../sindral-ai-design/HANDOFF.md` and the runnable `../sindral-ai-design/src/` prototype define layout, interaction, and visual intent.
3. Existing production code in this repository defines established implementation conventions where it does not conflict with the two sources above.
4. Security and correctness take precedence over copying prototype-only shortcuts such as local state, mocked code views, or client-generated identifiers.

## Task contract

### Required behavior

- A signed-in user can create a task from free text, an uploaded Markdown/text plan, or an allow-listed Jira, Linear, or GitHub issue URL.
- A task selects one or more GitHub repositories and a workflow, and pins an immutable workflow snapshot when execution starts.
- Workflows may contain human gates, Claude/Codex agent steps, feedback loops, verification, failure recovery, and a terminal state.
- A local authenticated worker claims jobs for its owning user, runs them in task-specific git worktrees (or a temporary directory for non-code work), streams progress, validates structured results, and reports completion or failure.
- The default workflow covers planning, plan feedback, implementation, adversarial review, verification, implementation feedback, human review, merge, and completion.
- Large changes can become ordered subtasks with separate stacked PRs, just-in-time plans, serial advancement, downstream rebases, and bounded automatic conflict resolution.
- GitHub review comments become task feedback and Sindral posts the agent response back to GitHub.
- Users can see live task state, plans, messages, steps, diffs, artifacts, subtasks, workflow definitions, worker health, and settings.
- Every read and mutation is scoped to the authenticated user, secrets are never returned or logged, and all external or agent-produced input is validated.

### Acceptance criteria

- A user can guide a code task from `todo` to one or more **confirmed merged** GitHub PRs without opening a code editor.
- A user can complete a non-code task and retrieve its artifacts from the portal.
- An agent or worker failure becomes an actionable `failure` state; retry/troubleshoot paths cannot silently duplicate jobs or side effects.
- Concurrent tasks use separate worktrees and no user can read, mutate, claim, or receive events for another user's data.
- Editing a workflow cannot change an in-flight task's pinned workflow.
- A resolvable stacked-branch conflict can be repaired automatically, validated, audited, and propagated through later branches; an unsafe or ambiguous conflict is escalated without changing the remote branch.
- All packages pass strict typechecking, tests, linting, builds, migration checks, and the security/integration gates below.

### Explicit non-goals for the first production release

- Hosting arbitrary workers on Sindral-managed infrastructure.
- Supporting source-control providers other than GitHub.
- A general-purpose visual programming language beyond task workflows.
- Unbounded or unverified conflict resolution that changes product behavior without an auditable agent result and passing validation.
- Billing, enterprise organizations/RBAC, or a plugin marketplace.
- Guaranteed containment of a malicious local user who controls the worker host.

## Current-system investigation

### Verified baseline

- `packages/shared` is the cross-process contract: domain types, Zod schemas, bundled workflows, prompt interpolation, workflow validation, and the pure `transition()` state machine.
- `apps/server` is a Fastify API with user JWT authentication, worker-key authentication, task/workflow/settings/ticket/webhook routes, SSE updates, an orchestration service, an in-memory test repository, and a Supabase repository.
- `apps/worker` polls for jobs, serializes work per task, prepares clones/worktrees, invokes Claude or Codex without a shell, validates result files, creates or updates PRs through `gh`, uploads text artifacts, and runs stack rebase jobs.
- `apps/web` implements authentication, Home, Tasks, Task Detail, Workflows, and Settings using React Router, TanStack Query, SSE invalidation, and the Figma design tokens.
- `supabase/migrations/20260921000000_init.sql` defines the current schema, indexes, claim RPC, triggers, and owner-only RLS read policies.
- The repository has no commits yet and all implementation files are currently untracked. Establishing a reviewable baseline is therefore the first delivery step.
- On 2026-09-21, `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build` all passed. The test suite contains 232 passing tests. The web build emits a roughly 893 kB JavaScript chunk and a Vite chunk-size warning.

### Existing patterns to preserve

- All state changes go through `packages/shared/src/stateMachine.ts`; routes and workers do not assign task states directly.
- Runtime boundaries use schemas from `packages/shared/src/schemas.ts`.
- Server persistence is accessed through `apps/server/src/db/repository.ts`, with the memory implementation used for fast service/route tests.
- Every server repository operation accepts a `userId`; cross-tenant resources return not-found rather than disclosing existence.
- Worker commands use executable/argv pairs, stripped environments, redacted logs, validated paths/refs, and an `AbortSignal`.
- UI data comes through `apps/web/src/lib/api.ts` and query hooks; the Figma prototype is a visual reference, not a source of production state.

### Material gaps in the baseline

1. **Merge semantics:** the `accept` transition currently reaches `done`; it does not merge a PR or verify that GitHub reports it merged. This does not yet meet the product acceptance criterion.
2. **Multi-repository results:** a worker may create a PR in every selected repository, but the task/result model stores only one `prUrl`, `branch`, and `baseBranch`. Review, feedback, merge, and audit behavior for the other PRs is therefore incomplete.
3. **Atomic orchestration:** state updates, events, job creation, and result application span several repository calls. Production needs a transactional/idempotent boundary to prevent duplicate jobs or half-applied transitions under retries and concurrent requests.
4. **Credential model:** the current encrypted GitHub PAT is sent with each matching job. Calling it “short-lived” is inaccurate unless GitHub App installation-token exchange is added.
5. **Production evidence:** tests use memory repositories and mocked process/GitHub boundaries. There is no automated local-Supabase RLS/migration suite, real git-worktree fixture test, browser E2E suite, or end-to-end worker/server contract test.
6. **Operability:** job leases, deployment topology, backups, retention, alerting, and disaster recovery need explicit production configuration and runbooks.
7. **Frontend delivery:** route-level code splitting and bundle budgeting are needed before release; the current build exceeds Vite's default chunk warning threshold.

## Target architecture

```text
Browser (Supabase JWT)
  ├── HTTPS JSON API ───────────────┐
  └── authenticated SSE ────────────┤
                                    ▼
                           Fastify orchestrator
                           ├── transactional task transitions
                           ├── workflow snapshots and job leases
                           ├── ticket and GitHub webhook adapters
                           └── encrypted secret broker
                                    │ service role, server only
                                    ▼
                             Supabase Postgres
                                    ▲
                                    │ scoped worker key + long polling
                                    │ job events/results
                              Local Node worker
                           ├── per-task git worktrees
                           ├── Claude/Codex adapters
                           ├── worker-owned git/gh side effects
                           └── non-code temp workspaces/artifacts
```

The shared package remains the only definition of workflow, transition, job, and result contracts. The server owns durable state and orchestration decisions. The worker owns local process and repository side effects. The browser never receives provider credentials or the Supabase service-role key.

## Behavioral contract

### New or completed behavior

- Replace the direct `in-review → done` edge for code workflows with `in-review → merge → done`. A merge job must report every PR's terminal GitHub state before completion.
- Represent repositories and PRs as collections, not a single nullable URL/branch tuple. Each repository records base branch, working branch, PR URL/number, head SHA, merge state, and last synchronization time.
- Give every transition request and worker completion an idempotency key. Applying the same event/result twice returns the original outcome and creates no duplicate job, message, artifact, webhook response, or PR comment.
- Claim jobs using a lease with heartbeat/expiry semantics. A stale lease may be reclaimed only when the previous attempt can no longer report a valid completion.
- Treat parent completion as a derived orchestration outcome: all required subtasks/PRs must reach their configured terminal condition before the parent completes.
- When a stacked-branch rebase conflicts, dispatch a dedicated conflict-resolution job in the affected worktree. The resolver receives the conflicting commits, approved plans, earlier-subtask outcomes, conflict hunks, and repository instructions; it may resolve only the conflicted files, must preserve both changes' stated intent, and must return a structured explanation of every resolution.
- Accept an automatic resolution only when the repository is conflict-free, the diff stays within configured limits, protected files are untouched unless explicitly allowed, required checks pass, and the rebased branch can be pushed with `--force-with-lease`. Otherwise abort the rebase and move the affected subtask to an actionable human-review/failure state without altering the remote branch.
- Preserve the Figma page structure and visual language while using server data, accessible controls, responsive layouts, and explicit loading/error/empty states.

### Behavior that remains unchanged

- Human review gates remain mandatory in the bundled Full SDLC workflow.
- In-flight tasks continue using their pinned workflow snapshot after the source workflow is edited or deleted.
- Verification `NO_GO` and human/GitHub feedback return to an implementation-feedback step; successful updates repeat adversarial review and verification.
- Rebase conflicts and their attempted resolutions remain visible in task events, chat, and job logs. Failed or unsafe automatic attempts fall back to human/agent troubleshooting rather than being hidden or repeatedly retried.
- Provider secrets remain server-side encrypted and worker keys remain one-time-visible, hashed, revocable credentials.

## Implementation steps

Each numbered item should be a separate PR unless a smaller split is noted. Every PR must include its own tests and leave the monorepo green.

### 1. Establish and document the baseline

- Commit the current monorepo as a reviewable baseline after removing generated `dist/`, local Supabase state, and other ignored artifacts from the candidate diff.
- Update `README.md` and `docs/SECURITY.md` so claims match implemented behavior, especially GitHub token lifetime and the current absence of automatic merge.
- Add an architecture decision record for the decisions listed in **Plan assumptions and required decisions**.
- Extend CI to run frozen install, typecheck, tests, lint, build, dependency audit, and a generated-artifact cleanliness check.

### 2. Normalize repository and pull-request state

- In `packages/shared/src/types.ts` and `schemas.ts`, replace the single-PR task contract with `TaskRepository`/`PullRequest` collections and define merge-job/result schemas.
- Add a forward-only Supabase migration introducing `task_repositories` and `pull_requests`, unique per task/repository. Backfill existing task columns, retain old columns for one compatibility release, then remove them in a later migration.
- Extend `Repository`, `MemoryRepository`, and `SupabaseRepository` with user-scoped CRUD methods and relationship loading.
- Update API response types, task detail UI, code/diff selection, subtask display, and fixtures so all selected repositories and PRs are visible.
- Add migration/backfill tests and multi-repository contract tests before changing worker behavior.

### 3. Make orchestration atomic and idempotent

- Add task version numbers and an `idempotency_keys`/command ledger (or equivalent unique command records) in Supabase.
- Move “validate current version → transition → append event → enqueue effect” into a Postgres transaction/RPC with owner checks. The service-role client may invoke it, but `anon` and `authenticated` roles must not.
- Apply worker results transactionally: lock the job/task, verify lease + expected attempt + expected result kind, write plan/PR/artifact state, append messages/events, transition, and enqueue the next job once.
- Require an idempotency key on task actions, chat-triggered feedback, GitHub webhook ingestion, and worker completion/failure endpoints. Return the stored response on replay.
- Add race tests for double-clicks, duplicate webhooks, late completions, stale worker attempts, simultaneous human and agent actions, and two workers claiming the same task.

### 4. Add merge as an explicit side effect

- Add a bundled `merge` agent/worker step after human acceptance for code workflows. The worker, not the model subprocess, performs the GitHub merge command/API call.
- Record and verify the expected repository, PR number, base branch, and head SHA before merging to prevent confused-deputy or stale-head merges.
- For stacked subtasks, merge in dependency order and rebase/update remaining heads between merges as required. Stop on protection failures or conflicts and move the affected task to `failure` with a precise recovery action.
- Consume GitHub pull-request webhooks to reconcile `open`, `closed`, and `merged` state. A manual merge outside Sindral should advance the same durable state without duplicating side effects.
- Mark a code task `done` only after all required PR records are confirmed merged. “Accept without merge” should be a distinct explicitly configured terminal action if the product chooses to support it.
- Add worker unit tests, server transition tests, GitHub webhook replay tests, and an integration test using a fake `gh` executable.

### 5. Add bounded automatic conflict resolution for stacked rebases

- Extend the shared job/result contract with a `resolve-rebase-conflict` job carrying the parent/child task IDs, repository, source and target branches/SHAs, conflicted paths, approved plans, earlier-subtask summaries, and the original rebase attempt. Validate all refs and paths at both server and worker boundaries.
- Update `apps/worker/src/rebase.ts` so a conflict aborts the initial rebase and returns the exact conflicting commits and paths. The server orchestrator uses that structured result to enqueue a resolver job instead of immediately parking the subtask. Keep the remote branch unchanged until the resolution passes every gate.
- Run the resolver in a fresh task-specific worktree at the recorded SHAs. Reproduce the rebase, invoke a dedicated Claude/Codex conflict-resolution step with write access limited to conflicted paths and read access to relevant repository context, then require a structured result containing per-file rationale, assumptions, unresolved concerns, and commands/checks run.
- Reject changes outside the conflicted path allow-list except for deterministic lockfile regeneration explicitly declared by the workflow. Treat migrations, auth/authorization policy, dependency manifests, generated artifacts, CI/deployment files, and binary conflicts as protected by default and require human approval unless repository configuration opts them in.
- Gate success on: no unmerged entries or conflict markers; clean index/worktree after the resolution commit; no unexpected commits; diff/line/file thresholds; repository-defined typecheck, test, lint, and build commands; optional targeted tests selected from touched paths; and verification that source/target heads have not changed since dispatch.
- Push the resolved branch only with `--force-with-lease=<branch>:<expected-sha>`. If the lease fails, discard the worktree and re-evaluate from the new heads rather than overwriting newer work.
- Limit automatic resolution to one configured attempt per source/target SHA pair. On ambiguity, protected-file involvement, validation failure, timeout, head drift, or a second conflict, abort cleanly and transition to a `conflict-review` human gate (or `failure` for workflows without that gate) with the patch, rationale, failed checks, and reproduction commands attached.
- Persist a conflict-resolution record containing input SHAs, conflicted paths, model/engine, prompt version, resolution diff hash, validation evidence, outcome, and resulting commit SHA. Surface this record in Task Detail and the state-event timeline.
- After a successful resolution, resume downstream stack rebases from the new commit and invalidate/re-run adversarial review and verification for every affected open subtask before merge.
- Add deterministic tests for independent-line conflicts, delete/modify and rename conflicts, overlapping semantic edits, lockfiles, protected files, binary files, stale heads, failed checks, retry limits, remote push failure, and successful cascading rebases.

### 6. Harden worker dispatch, leases, and credentials

- Replace claimed-at timeout inference with renewable leases (`lease_owner`, `lease_expires_at`, attempt token). Heartbeats extend both worker presence and active job leases.
- Reject completion from an expired/superseded attempt and ensure shutdown cancellation cannot race a successful completion.
- Prefer GitHub App installation tokens minted for the selected repositories. If PATs remain in v1, describe them accurately, scope them to selected repositories, never expose them to agent subprocesses, and support immediate rotation/revocation.
- Keep clone/worktree directories under the configured worker root; revalidate canonical paths after filesystem creation to guard against symlink/path traversal.
- Define cleanup/retention for worktrees, temp directories, result files, and logs. Cleanup must refuse active leases and provide a dry-run mode.
- Add platform tests for macOS/Linux path handling, interrupted processes, CLI absence/version mismatch, timeouts, large output, retryable network errors, and credential redaction.

### 7. Complete ticket, feedback, and artifact integrations

- Keep exact-host allow lists and provider-specific URL parsing for ticket import; add response-size/time limits, redirect rejection, content-type checks, and normalized provider errors.
- Verify GitHub webhook signatures against the raw request body, enforce delivery-ID idempotency, ignore Sindral-authored marker comments, and map comments to an exact tracked PR/repository.
- Post agent feedback responses to the originating GitHub thread where the API permits; otherwise post a PR-level comment linked to the source comment.
- Move non-code artifact payloads out of inline database text when they exceed a small threshold. Use a private Supabase Storage bucket with owner-checked signed downloads, content-size/type allow lists, retention, and malware scanning if binary uploads are later enabled.
- Add contract tests for Linear/Jira/GitHub imports, redirects/SSRF attempts, webhook duplicates, cross-task PR references, artifact limits, and signed-download authorization.

### 8. Finish the production web experience from the Figma handoff

- Preserve the prototype's Home, Tasks, Task Detail, Workflows, and Settings information architecture and design tokens in `apps/web/src/index.css`.
- Home: validate file size/type before reading, display imported-ticket provenance, support multiple repository selection clearly, and show actionable worker readiness before Start.
- Task Detail: show per-repository PR/merge state, live agent logs, plan revisions, a dynamic workflow-derived pipeline, artifacts, subtasks, conflict-resolution attempts, and state-specific actions. Let users inspect the proposed resolution diff/evidence and approve or reject escalated conflicts. Disable duplicate submissions while preserving server conflict messages.
- Workflows: retain graph editing while validating reachability, terminal paths, edge events, engine/output compatibility, permissions, and unsaved navigation. Clearly distinguish the editable workflow from a task's pinned snapshot.
- Settings: expose secret status/rotation, worker-key revocation, GitHub repository access checks, and worker capabilities without rendering secret values.
- Add keyboard/focus behavior, reduced-motion support, accessible labels/status announcements, responsive layouts, and WCAG AA color/focus checks.
- Route-split page bundles and isolate editor/markdown/diff dependencies. Add a CI bundle budget based on compressed route chunks.

### 9. Add real integration and end-to-end verification

- Add a local-Supabase test project that applies migrations from zero and tests every RLS table/RPC with user A, user B, anon, authenticated, worker, and service-role contexts.
- Add server repository integration tests against Supabase, including transactional transitions, claim fairness, lease expiry, backfills, and pagination.
- Add worker integration fixtures with temporary bare Git repositories and fake Claude/Codex/`gh` binaries. Exercise plan, implementation, feedback, clean rebases, automatically resolved conflicts, escalated conflicts, artifact, cancellation, and merge paths without network access.
- Add Playwright browser tests for sign-in, all three task-intake modes, workflow pinning, plan feedback, implementation review, failure/retry, non-code artifacts, and multi-repository PR status.
- Add one controlled staging smoke test against a dedicated GitHub sandbox repository and test Supabase project. Use disposable branches/PRs and clean them after the run.
- Create a traceability matrix mapping every requirement in `sindral-ai-engineering.md` and every production-relevant interaction in the Figma handoff to an automated test or an explicit manual release check.

### 10. Production operations and staged rollout

- Package the server and web assets into one immutable deployment artifact; publish the worker as a versioned npm package or signed executable with a compatibility protocol version.
- Add startup checks for migration version, encryption key shape, Supabase connectivity, web origin, webhook secret, and worker/server protocol compatibility.
- Emit structured metrics for task/job counts by state, claim latency, job duration, retry/lease expiry, worker heartbeat age, transition conflicts, rebase conflicts, automatic-resolution success/escalation rates, validation failures, webhook failures, and merge failures. Correlate logs with `userId`, `taskId`, `jobId`, and request/delivery IDs without logging content or secrets unnecessarily.
- Define database backups, point-in-time recovery, secret-key rotation, incident response, retention/deletion, and worker upgrade runbooks.
- Roll out in stages: internal single-user sandbox; invited multi-user beta; merge disabled by default with dry-run evidence; merge enabled for allow-listed repositories; general availability after security and recovery exercises.
- Keep a server-side kill switch for new job dispatch and automatic merge while leaving read/review access available.

## Expected diff

### Files likely modified

- `packages/shared/src/{types,schemas,stateMachine,defaultWorkflows,api}.ts` and corresponding tests, including the conflict-resolution job/result contract and human escalation state.
- `apps/server/src/services/orchestrator.ts`, repository interfaces/implementations, auth, GitHub service, task/worker/webhook routes, config, and tests.
- `apps/worker/src/{api,runner,job,github,rebase,workspace,config}.ts`, a conflict resolver/validation module, engine adapters, CLI, and tests.
- `apps/web/src/lib/api.ts`, query hooks, Home/Tasks/TaskDetail/Workflows/Settings pages, task-detail components, styles, and tests.
- `.github/workflows/ci.yml`, `.env.example`, `README.md`, `docs/SECURITY.md`, and operational documentation.

### Files likely added

- Forward-only Supabase migrations for repository/PR records, command idempotency, task versions, and job leases.
- Transaction/RPC integration tests and local-Supabase test helpers.
- Playwright configuration and browser journeys.
- Git/CLI worker fixtures and a staging smoke-test harness.
- Conflict-resolution records/migrations, protected-path configuration, and resolution test fixtures.
- Architecture decision records and deployment/incident/backup/rotation runbooks.

### Generated artifacts

- `dist/`, coverage, Playwright reports, local Supabase state, worker logs, and temporary worktrees remain ignored and are never committed.

## Security and trust-boundary controls

- **Browser → server:** verify Supabase JWT issuer, audience, expiry, and signature; derive user identity only from the token; rate-limit expensive and mutating routes; use exact CORS origins and secure headers.
- **Server → database:** keep the service-role key server-only; scope every repository call by user; enforce RLS as defense in depth; revoke transactional RPC execution from browser roles.
- **Worker → server:** hash one-time worker keys, bind them to one user, support revocation, require TLS, use lease attempt tokens, and expose only that user's jobs.
- **Server → worker:** deliver credentials only for the job's repositories; prefer short-lived GitHub App tokens; never place secrets in prompts, logs, URLs, database events, or browser responses.
- **Worker → local machine/GitHub:** validate repo/ref/path inputs, avoid shell evaluation, constrain agent permissions, isolate worktrees, verify PR identity/head SHA before push or merge, and redact both known and pattern-matched credentials.
- **External inputs:** cap sizes, validate schemas, sanitize rendered Markdown by disallowing raw HTML, reject unexpected redirects/hosts, verify webhook HMACs, and deduplicate delivery IDs.
- **Tenant isolation:** test every table, RPC, stream, webhook lookup, signed artifact URL, worker claim, and error path for cross-user denial.

## Risk controls

| Risk | Level | Control in this plan |
|---|---|---|
| Incorrect or duplicate state transitions | High | Transactional transition/result RPCs, task versions, idempotency keys, concurrency tests. |
| Destructive or stale GitHub side effects | High | Explicit merge step, stored PR identity/head SHA, worker-owned side effects, dry-run rollout, kill switch. |
| Cross-tenant data or job access | High | User-scoped repositories, RLS/RPC tests with two users, scoped SSE and worker keys. |
| Credential disclosure | High | GitHub App tokens or accurately scoped PATs, encryption, stripped subprocess env, redaction tests, rotation. |
| Agent command/path injection | High | argv-only execution, validated refs/repositories, canonical-path containment, no secrets in prompts. |
| Lost/duplicated work after worker failure | High | Renewable leases, attempt tokens, late-result rejection, idempotent completion, shutdown tests. |
| Incorrect automatic conflict resolution | High | Fresh worktree at pinned SHAs, conflicted-path write allow-list, protected-file escalation, structured rationale, diff limits, mandatory checks, force-with-lease, one-attempt cap, audit record, and human fallback. |
| Stacked PR divergence/conflicts | High | Ordered dependency records, serialized progression, automatic resolution only behind validation gates, downstream re-review, stop-and-recover fallback, integration fixtures. |
| Schema/backfill regression | Medium | Expand/backfill/contract migrations, local reset + upgrade tests, compatibility window. |
| Prototype/production UI drift | Medium | Figma traceability checklist, component/E2E tests, accessibility and responsive review. |
| Frontend load performance | Medium | Route splitting, bundle budget, production telemetry. |
| Vendor/CLI changes | Medium | Capability/version handshake, adapter contract tests, staged worker release. |

## Verification contract

The portal is production-ready only when all of the following evidence exists:

1. `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build` pass in CI on the supported Node version.
2. Supabase can migrate both from an empty database and from the previous release schema; rollback/recovery is rehearsed on a disposable environment.
3. RLS/RPC tests prove user A cannot access user B's tasks, workflows, messages, events, artifacts, jobs, workers, secrets, keys, repository records, PR records, or event streams.
4. Concurrency tests prove one event/result produces one transition and one downstream job under retries, duplicates, and races.
5. Worker integration tests use real temporary git repositories/worktrees and prove isolation, commit/push/PR/feedback/rebase/conflict-resolution/merge behavior, protected-path enforcement, stale-head rejection, cancellation, retry, and redaction.
6. Browser E2E tests cover the default happy path, plan and implementation feedback loops, automatically resolved and human-escalated conflicts, failure/troubleshoot/retry, non-code artifacts, workflow pinning, subtasks, multiple repositories, and worker-offline errors.
7. A staging task completes from each intake mode through a real sandbox PR merge, and a non-code task completes with a downloadable artifact.
8. Dependency, secret, static-analysis, and dynamic security scans have no unresolved high/critical findings; the OWASP controls in `docs/SECURITY.md` are manually reviewed.
9. Accessibility checks pass for keyboard navigation, focus management, names/roles, status announcements, reduced motion, contrast, and responsive layouts.
10. Dashboards/alerts, backup restore, GitHub/webhook failure recovery, worker revocation, encryption-key rotation, and the dispatch/merge kill switches are demonstrated in staging.

## Plan assumptions and required decisions

### Verified

- The production codebase is the `sindral-ai/` pnpm monorepo; `sindral-ai-design/` is a design/prototype reference.
- React/Vite, Fastify, Node worker processes, Supabase/Postgres, GitHub, Claude, and Codex are the intended v1 technologies.
- The current baseline builds cleanly and its 232 tests pass.
- Multiple users, multiple repositories per task, workflow pinning, subtasks, non-code tasks, and GitHub feedback are in scope.

### Low-risk assumptions

- Email/password and GitHub OAuth through Supabase Auth are sufficient for the first release.
- SSE plus query invalidation is sufficient for portal live updates; workers may use authenticated long polling with leases.
- Text/Markdown artifacts are sufficient initially; binary artifact support can wait until scanning and storage policy are defined.
- macOS and Linux are the supported worker hosts for v1; Windows support is deferred.

### Approved decisions

1. **Completion semantics:** Does “Accept” authorize Sindral to merge, or should it only record approval and wait for a separate Merge action/webhook? Recommended: separate `Accept & merge` confirmation, with `done` only after GitHub confirms merge.
2. **Merge policy:** Which methods are allowed (`squash`, `merge`, `rebase`) and may repository settings choose automatically? Recommended: per-repository setting defaulting to squash, while respecting required checks/reviews and never bypassing protection.
3. **Multi-repository atomicity:** Is partial success acceptable when some PRs merge and another fails? Recommended: ordered best-effort with an explicit partial-merge failure state and recovery runbook, because GitHub cannot provide a cross-repository transaction.
4. **GitHub credential strategy:** GitHub App installation tokens or user PATs for v1? Recommended: GitHub App before enabling automatic merge; PATs may remain for an internal prototype only.
5. **Deployment/tenancy model:** single shared service or one deployment per customer? Recommended: shared multi-tenant service with the RLS and isolation gates above unless enterprise deployment is an immediate requirement.
6. **Conflict-resolution policy:** Which files may be resolved automatically, what diff/check thresholds apply, and which model/engine may perform the work? Recommended: default-deny protected file classes; repository-owned allow/deny patterns and required commands; one attempt per SHA pair; no binary resolution; and mandatory human escalation whenever intent cannot be proven from the approved plans and tests.

The decisions above were approved on 2026-09-21 and are recorded in `docs/adr/0001-production-delivery-semantics.md`.

## Plan verdict

`READY_TO_TEST_DESIGN`.
