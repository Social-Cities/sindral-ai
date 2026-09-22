# Requirement traceability

This matrix maps the product requirements in `../sindral-ai-engineering.md` and the production-relevant interactions in `../sindral-ai-design/HANDOFF.md` to executable evidence or an explicit release check. It is the release checklist, not a claim that external staging work has happened.

Evidence classes:

- **Automated** — runs locally and/or in CI from this repository.
- **Live local** — runs against a real local Supabase and server process.
- **Staging** — requires the dedicated GitHub/Supabase sandbox and real credentials.
- **Manual** — a human release exercise or visual/accessibility review whose result must be recorded.

## Engineering requirements

| ID | Requirement | Evidence | Gate |
|---|---|---|---|
| ENG-01 | Create tasks from free text, uploaded Markdown/text, or Linear/Jira/GitHub URL | `e2e/portal.spec.ts`; `apps/web/src/pages/Home.test.tsx`; `apps/server/src/services/tickets.test.ts` | Automated |
| ENG-02 | New tasks begin in Todo and can be started by a user | `apps/server/src/services/orchestrator.test.ts`; `apps/web/src/pages/TaskDetail.test.tsx`; `scripts/smoke.mjs` | Automated + live local |
| ENG-03 | Default workflow plans, accepts plan feedback, implements, adversarially reviews, verifies, accepts implementation feedback, merges, and completes | `packages/shared/src/stateMachine.test.ts`; `apps/server/src/services/orchestrator.test.ts`; `scripts/smoke.mjs` | Automated + live local |
| ENG-04 | Code completion means every required PR is confirmed merged | `apps/worker/src/merge.test.ts`; `apps/server/src/services/orchestrator.test.ts`; `apps/server/src/routes/webhooks.test.ts` | Automated; real merge is STG-01 |
| ENG-05 | Failures park safely and support retry and troubleshoot recovery | `apps/server/src/services/orchestrator.test.ts`; `apps/web/src/pages/TaskDetail.test.tsx`; `e2e/portal.spec.ts` | Automated |
| ENG-06 | User feedback at plan and implementation gates dispatches the correct revision | `apps/server/src/services/orchestrator.test.ts`; `apps/web/src/pages/TaskDetail.test.tsx`; `e2e/portal.spec.ts` | Automated |
| ENG-07 | Workflows are customizable, validated, and may mix Claude/Codex agent and human steps | `packages/shared/src/workflow.test.ts`; `apps/web/src/pages/Workflows.test.tsx`; `apps/worker/src/engines/engines.test.ts` | Automated |
| ENG-08 | In-flight tasks use an immutable workflow snapshot | `apps/server/src/services/orchestrator.test.ts`; `e2e/portal.spec.ts` | Automated |
| ENG-09 | Large tasks become ordered, just-in-time planned subtasks and parents complete only after children | `apps/server/src/services/orchestrator.test.ts`; `apps/web/src/pages/Tasks.test.tsx` | Automated |
| ENG-10 | Stacked branches rebase in order and propagate earlier changes | `apps/server/src/services/orchestrator.test.ts`; `apps/worker/src/rebase.test.ts` | Automated; real remote is STG-02 |
| ENG-11 | Rebase conflicts receive one bounded automatic resolution attempt with protected-path, diff, check, and force-lease gates | `apps/worker/src/conflict.test.ts`; `apps/server/src/services/orchestrator.test.ts`; `e2e/portal.spec.ts` | Automated; real remote is STG-02 |
| ENG-12 | Unsafe conflict resolutions leave the remote unchanged and expose rationale/evidence for recovery | `apps/worker/src/conflict.test.ts`; `apps/server/src/services/orchestrator.test.ts`; `e2e/portal.spec.ts` | Automated |
| ENG-13 | GitHub issue/review comments become feedback and Sindral replies without loops or duplicates | `apps/server/src/routes/webhooks.test.ts`; `apps/worker/src/github.test.ts`; `supabase/tests/durable_github_webhooks.test.sql` | Automated; real webhook is STG-03 |
| ENG-14 | Code jobs run in isolated worktrees and same-task jobs serialize | `apps/worker/src/workspace.integration.test.ts`; `apps/worker/src/job.integration.test.ts`; `apps/worker/src/runner.test.ts`; `apps/server/src/services/orchestrator.test.ts` | Automated |
| ENG-15 | Non-code jobs use temporary workspaces and expose bounded private artifacts | `apps/worker/src/workspace.test.ts`; `apps/worker/src/job.test.ts`; `apps/server/src/routes/routes.test.ts`; `supabase/tests/private_artifact_storage.test.sql`; `e2e/portal.spec.ts` | Automated + live local |
| ENG-16 | A task may select multiple repositories and a workflow | `apps/server/src/services/orchestrator.test.ts`; `apps/web/src/pages/Home.test.tsx`; `e2e/portal.spec.ts` | Automated |
| ENG-17 | Multiple PRs are stored, shown, reviewed, and merged in deterministic order | `apps/server/src/services/orchestrator.test.ts`; `apps/worker/src/merge.test.ts`; `e2e/portal.spec.ts` | Automated; real merge is STG-01 |
| ENG-18 | Worker uses the dispatched engine/model/prompt/tools/permissions and validates structured output | `apps/worker/src/engines/engines.test.ts`; `apps/worker/src/prompt.test.ts`; `apps/worker/src/result.test.ts`; `apps/worker/src/job.test.ts`; `apps/worker/src/job.integration.test.ts` | Automated |
| ENG-19 | Worker authentication is one-time-visible, hashed, revocable, user-scoped, and protocol-versioned | `apps/server/src/auth/auth.test.ts`; `apps/server/src/routes/routes.test.ts`; `apps/worker/src/api.test.ts`; `apps/worker/src/runner.test.ts` | Automated |
| ENG-20 | Leases, heartbeats, retries, cancellation, and replay fencing prevent stale/duplicate outcomes | `apps/server/src/services/orchestrator.test.ts`; `apps/worker/src/runner.test.ts`; `supabase/tests/renewable_job_leases.test.sql`; `supabase/tests/durable_job_outcomes.test.sql` | Automated |
| ENG-21 | GitHub credentials are encrypted, scoped, redacted, and excluded from model subprocesses | `apps/server/src/services/crypto.test.ts`; `apps/server/src/services/githubApp.test.ts`; `apps/worker/src/engines/engines.test.ts`; `apps/worker/src/redact.test.ts` | Automated; rotation is OPS-03 |
| ENG-22 | Every user/API/database/event path is tenant scoped | `apps/server/src/routes/routes.test.ts`; `apps/server/src/auth/auth.test.ts`; `supabase/tests/tenant_isolation_matrix.test.sql`; `supabase/tests/browser_role_privileges.test.sql`; `scripts/smoke.mjs` | Automated + live local |
| ENG-23 | External inputs resist SSRF, redirects, oversized responses, malformed bodies, and webhook forgery | `apps/server/src/services/tickets.test.ts`; `apps/server/src/routes/webhooks.test.ts`; `apps/server/src/routes/routes.test.ts` | Automated |
| ENG-24 | State changes and worker outcomes are atomic and idempotent under duplicates/races | `apps/server/src/services/orchestrator.test.ts`; `supabase/tests/atomic_task_transitions.test.sql`; `supabase/tests/durable_job_outcomes.test.sql` | Automated |
| ENG-25 | All changes are typechecked, tested, linted, built, dependency-audited, database-tested, and bundle-budgeted | `.github/workflows/ci.yml`; root `package.json` scripts | Automated |
| ENG-26 | Production has startup compatibility checks, kill switches, metrics, alerts, and recovery procedures | `apps/server/src/config.test.ts`; `apps/server/src/db/supabase.test.ts`; `apps/server/src/metrics.test.ts`; `docs/operations/` | Automated + OPS gates |

## Design handoff and interaction coverage

| ID | Interaction or visual contract | Evidence | Gate |
|---|---|---|---|
| UX-01 | Authenticated shell, sign-in/account creation, protected redirects | `apps/server/src/auth/auth.test.ts`; `e2e/portal.spec.ts` | Automated |
| UX-02 | Home free-text and URL tabs, Cmd/Ctrl+Enter, upload validation, workflow selector | `apps/web/src/pages/Home.test.tsx`; `e2e/portal.spec.ts` | Automated |
| UX-03 | Imported-ticket provider/id provenance is visible and editable | `apps/web/src/pages/Home.test.tsx`; `e2e/portal.spec.ts` | Automated |
| UX-04 | Todo/In Progress/In Review dashboard counts link to filtered tasks | `apps/web/src/pages/Home.test.tsx`; `apps/web/src/pages/Tasks.test.tsx` | Automated |
| UX-05 | Worker readiness distinguishes online, idle/running, registered-offline, and absent | `apps/web/src/pages/Home.test.tsx`; `e2e/portal.spec.ts` | Automated |
| UX-06 | Tasks search, status filters, hierarchy, status/workflow/linked/PR badges, and empty states | `apps/web/src/pages/Tasks.test.tsx` | Automated |
| UX-07 | Task top bar exposes only state-valid actions and disables duplicate submissions | `apps/web/src/pages/TaskDetail.test.tsx`; `e2e/portal.spec.ts` | Automated |
| UX-08 | Summary renders description, repositories, plan, every PR state, and state callouts | `apps/web/src/pages/TaskDetail.test.tsx`; `e2e/portal.spec.ts` | Automated |
| UX-09 | Pipeline is workflow-derived and labels failure, troubleshoot, and conflict resolution accurately | `packages/shared/src/workflow.test.ts`; `e2e/portal.spec.ts` | Automated |
| UX-10 | Chat is keyboard-operable, announces messages, and clearly identifies feedback-triggering gates | `apps/web/src/pages/TaskDetail.test.tsx`; `e2e/portal.spec.ts` | Automated; keyboard audit is A11Y-01 |
| UX-11 | Code view selects repository, file tree, and diff without exposing credentials | `apps/server/src/routes/routes.test.ts`; `e2e/portal.spec.ts` | Automated |
| UX-12 | Steps show audit timeline, job state, attempts, logs, and conflict-resolution work | `e2e/portal.spec.ts`; `apps/server/src/services/orchestrator.test.ts` | Automated |
| UX-13 | Artifact view previews safe inline text and offers owner-authorized stored downloads | `apps/web/src/pages/taskDetail/ArtifactsTab.test.tsx`; `e2e/portal.spec.ts`; `scripts/smoke.mjs` | Automated + live local |
| UX-14 | Subtasks show sequence and parent/child progress | `apps/web/src/pages/Tasks.test.tsx`; `apps/server/src/services/orchestrator.test.ts` | Automated |
| UX-15 | Workflow editor displays graph, selects/configures steps, validates drafts, saves changes, and shows pinning | `apps/web/src/pages/Workflows.test.tsx`; `packages/shared/src/workflow.test.ts` | Automated |
| UX-16 | Workflow deletion preserves pinned task snapshots | `apps/server/src/services/orchestrator.test.ts`; `apps/web/src/pages/Workflows.test.tsx` | Automated |
| UX-17 | Optimistic transitions roll back on server conflicts | `apps/web/src/pages/TaskDetail.test.tsx`; `apps/server/src/routes/routes.test.ts` | Automated |
| UX-18 | SSE invalidates affected task/worker queries and is user scoped | `apps/web/src/lib/events.test.ts`; `apps/server/src/routes/routes.test.ts` | Automated |
| UX-19 | Active agent states have a visible and announced working indicator | `apps/web/src/components/StatusBadge.test.tsx`; `apps/web/src/pages/TaskDetail.test.tsx`; `e2e/portal.spec.ts` | Automated |
| UX-20 | Handoff colors, type roles, cards, split layouts, and focus tokens are retained, with documented contrast corrections where AA takes precedence | `apps/web/src/index.css`; compare with `../sindral-ai-design/HANDOFF.md` | Automated contrast check + manual VIS-01 |
| UX-21 | Layouts remain usable at supported desktop/tablet widths and motion respects user preference | `apps/web/src/index.css`; `e2e/accessibility.spec.ts` | Automated + manual VIS-01 |

## External release gates

These are intentionally not marked complete by repository tests.

| ID | Required evidence | Procedure | Status |
|---|---|---|---|
| STG-01 | Each intake mode reaches a real confirmed merge in the dedicated GitHub sandbox; disposable PRs are removed | `scripts/staging-smoke.mjs`; `docs/operations/deployment.md` using a test Supabase project and GitHub App installation | Harness complete; execution pending external credentials/environment |
| STG-02 | A real stacked PR clean rebase, safe automatic conflict resolution, protected-file escalation, stale-head rejection, and cascading re-review complete against the sandbox remote | Worker upgrade/deployment smoke procedure; retain task events and conflict artifacts | Pending external credentials/environment |
| STG-03 | GitHub issue and review-comment deliveries are signed, replayed safely, reflected in the portal, and receive exactly one Sindral response | Send/re-deliver sandbox webhooks and retain delivery IDs | Pending external credentials/environment |
| OPS-01 | Empty migration and previous-version upgrade both succeed; backup restore and point-in-time recovery are timed and recorded | `docs/operations/backup-recovery.md` | Pending staging exercise |
| OPS-02 | Dispatch/merge kill switches, worker revocation, webhook outage recovery, and alert delivery are demonstrated | `docs/operations/incident-response.md` and `docs/operations/monitoring.md` | Pending staging exercise |
| OPS-03 | Provider, webhook, worker, service-role, metrics, and encryption-key rotation are demonstrated without data loss | `docs/operations/key-rotation.md` | Pending staging exercise |
| A11Y-01 | Keyboard order, focus return/trapping, names/roles/statuses, reduced motion, contrast, zoom, and responsive reflow pass | `e2e/accessibility.spec.ts` plus manual assistive-technology review | Automated serious/critical Axe, reflow, and reduced-motion checks pass; manual assistive-technology review pending |
| VIS-01 | Home, Tasks, Task Detail, Workflows, and Settings match the handoff at supported breakpoints with no clipped critical controls | Side-by-side review against `../sindral-ai-design`; `docs/release/visual-accessibility-audit-2026-09-22.md` | Passed 2026-09-22; desktop comparison plus automated 768px reflow evidence |
| SEC-01 | Dependency, secret, static, and dynamic scans have no unresolved high/critical findings; OWASP checklist signed off | `.github/workflows/ci.yml`; `.github/workflows/security.yml`; manual review of `docs/SECURITY.md` | Automated gates configured; first clean CI run and manual OWASP sign-off pending |
| REL-01 | Immutable server image provenance and versioned worker release checksum/signature are retained | `.github/workflows/release.yml`; `scripts/package-worker.mjs`; `docs/operations/deployment.md`; `docs/operations/worker-upgrade.md` | Automated release path configured; first signed tag requires release authority |

## Standard evidence commands

Run before a release candidate is tagged:

```sh
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

With the built server running against local Supabase, also run `pnpm smoke`. Store the CI run URL and all completed staging/manual gate records with the release record.
