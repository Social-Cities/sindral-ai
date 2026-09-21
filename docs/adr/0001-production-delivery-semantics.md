# ADR 0001: Production delivery semantics

- Status: Accepted
- Date: 2026-09-21

## Context

The production plan requires explicit choices for completion, merge behavior, multi-repository failure, GitHub credentials, tenancy, and automatic conflict resolution. These choices affect persisted contracts and destructive GitHub side effects, so they must be stable before implementation.

## Decisions

1. Human approval is exposed as **Accept & merge**. A code task reaches `done` only after GitHub confirms every required pull request is merged. Approval without merge, if added later, is a separate workflow event.
2. Merge policy is configured per repository and defaults to squash. Sindral respects required checks, reviews, and branch protection and never bypasses them.
3. Multi-repository merge is ordered best-effort. A later failure produces an explicit partial-merge failure with recovery instructions because GitHub cannot provide a cross-repository transaction.
4. Production automatic merge uses short-lived GitHub App installation tokens scoped to the selected repositories. Fine-grained PATs remain supported only for local/internal deployments while merge is disabled.
5. The service is shared and multi-tenant. User scoping and RLS isolation are release gates.
6. Automatic stacked-rebase conflict resolution is default-deny: repository-owned allow/deny patterns and required validation commands, one attempt per source/target SHA pair, no binary resolution, protected-file escalation, and human review whenever intent cannot be proven.

## Consequences

- Tasks need first-class repository and pull-request records rather than a single PR URL.
- Merge, conflict resolution, and human escalation become explicit workflow/job/result concepts.
- GitHub App installation and repository authorization are required before production merge can be enabled.
- Partial multi-repository completion is durable and visible instead of being rolled back or hidden.
- Conflict-resolution output is auditable and never pushed unless all configured safety gates pass.
