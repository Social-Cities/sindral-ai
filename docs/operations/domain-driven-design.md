# Domain Driven Design in code workflows

Domain Driven Design (DDD) is required for code produced by Full SDLC, Fast Track, Planning Only, Mobile App SDLC, and custom repository-backed engineering workflows. The requirement is added at agent dispatch as well as in bundled templates, so previously saved or pinned prompts also receive the current contract. Non-code documents and design prototypes retain their own workflows. This sets standards for new changes and the boundaries they touch; it does not claim that the entire existing repository has been refactored or certified.

## Plans and implementation

Every implementation plan includes a **Domain model** section describing the business capability, bounded contexts, ubiquitous language, important invariants and consistency boundaries, application use cases, ports, adapters, and dependency direction. Fast Track includes the same decisions in its brief implementation plan. Use the same domain vocabulary in BDD scenarios and explain how the tests cover invalid state transitions as well as successful behavior.

Group code within each bounded context by business capability. Separate domain, application, infrastructure and presentation responsibilities with dependencies pointing toward the domain. Folder names alone do not establish this separation. Use entities, value objects, aggregates and domain services where they express actual business behavior; do not add unnecessary layers, CQRS, domain events, or abstractions to small features.

- Domain models own business rules and invariants and have no dependencies on UI, transport, persistence or vendor SDKs.
- Application use cases coordinate domain operations through domain-owned or application-owned ports. They define workflow and transaction boundaries.
- Infrastructure adapters implement repository/integration ports, map database records and API DTOs, and handle Supabase and other external services.
- UI components and ViewModels invoke use cases. They own presentation state, not business policies or direct Supabase queries.

For mobile monorepos, use pure Swift domain types under `ios/`, pure Kotlin under `android/`, and framework-independent TypeScript/JavaScript modules under `web/`. Each platform keeps its own idiomatic implementation while sharing domain names, observable rules, and backend contracts. The Android handoff references iOS's domain model and ports as well as behavior. Supabase is an infrastructure boundary: SQL constraints, RLS and atomic operations still enforce data integrity and authorization. Keep migrations/configuration in `supabase/` and cover adapter contracts with integration tests.

Test business invariants and application use cases independently of UI and SDKs; use adapter integration tests for persistence and transport mappings. Add executable dependency/architecture checks where the repository supports them. Existing violations in touched code must be surfaced, and material violations must be fixed before readiness; avoid unrelated repository-wide rewrites.

## Review and readiness

Adversarial reviewers inspect actual imports, ownership and integration paths, not just directory structure. Findings cite files and lines, concrete violated invariants, a remediation and a regression test. Verifiers inspect dependencies and execute domain/invariant tests plus the relevant architecture and adapter checks.

A code workflow cannot return GO without one successful `dddChecks` entry for each of these criteria in every required scope:

1. `bounded-contexts`: context ownership, business vocabulary and integration contracts.
2. `domain-isolation`: business logic is independent of UI and SDKs.
3. `invariants`: meaningful domain operations and consistency boundaries protect valid states.
4. `dependency-direction`: use cases and ports separate domain logic from presentation and infrastructure adapters.
5. `domain-tests`: isolated domain/use-case tests and relevant adapter/architecture checks execute successfully.

For general code workflows, scopes are the task's repository names. For mobile workflows, scopes are the selected platform folders plus `supabase`. Checks for untouched scopes cite inspected boundaries and explain why no changes are needed. Every entry includes concrete source and test evidence; missing, failed, blocked, duplicated or empty entries are rejected by the server. The verifier's readable readiness report includes the same DDD matrix. Mobile BDD checks remain a separate mandatory release requirement.

As with BDD evidence, the verifier executes and reports checks; the server validates coverage, statuses and evidence presence. This gate does not mechanically prove DDD compliance or replace source review. The result contract ships with worker 0.4.0 / protocol 6 in this release; deploy server and worker together.
