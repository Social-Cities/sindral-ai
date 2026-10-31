# Mobile app engineering

Create a **Mobile app** project and choose default task platforms. iOS and Android are selected by default; Web is optional. Every task can override these defaults with any nonempty combination of iOS, Android, and Web. A project uses one repository with top-level `ios/`, `android/`, `web/`, and `supabase/` directories. New repositories receive these folders and an architecture README. Existing repositories are inspected and adapted by the implementation agents.

Use SwiftUI for iOS, Kotlin with Jetpack Compose for Android, and React for Web. All selected clients share one standard Supabase backend, migrations and API contracts. Android follows Google's [architecture recommendations](https://developer.android.com/topic/architecture/recommendations), including layered architecture, repositories, ViewModels, unidirectional data flow, coroutines and Flow.

All code follows [Domain Driven Design](domain-driven-design.md), including iOS, Android, Web, and the shared Supabase backend. Plans define bounded contexts, domain vocabulary and invariants; UI and persistence adapters remain separate from framework-independent domain logic. Verification requires passing DDD evidence for each selected platform and the shared backend, in addition to BDD tests.

Tasks created under mobile projects default to **Mobile App SDLC**. It retains Full SDLC's review slicing, adversarial review, verification, human release approval and merge, and adds BDD creation and revision:

1. Behavior Driven Design defines stable Given/When/Then scenario IDs, fixtures, assertions, test files and commands for every selected platform.
2. Implementation planning consumes the BDD plan and the task contract.
3. Plan Review exposes both plans. Choose **BDD test plan** or **Implementation plan** when requesting changes. BDD revisions are followed by implementation-plan reconciliation. Approval requires both plans.
4. Only the platforms selected on the task are implemented sequentially: iOS, Android, Web. Each has a distinct agent session, including on feedback passes. All receive both plans. Android reads the committed iOS implementation and handoff summary to reuse behavior and backend contracts. Unselected platforms are skipped. Shared Supabase work is owned by the first selected agent that needs it.
5. Review Slicer publishes the complete change; Adversarial Review checks it.
6. Verification executes every BDD scenario for every selected platform against the final branch. The server rejects GO without one successful check per scenario/platform, including command and observed evidence. Missing tooling, unavailable simulators/emulators, skipped tests and missing credentials must be reported as NO_GO.
7. The task becomes **Ready for Release** (the existing `in-review` state), followed by human approval and merge. NO_GO and code-review feedback repeat the isolated platform chain in the same order.

Task creation snapshots its selected platforms, using project defaults when no explicit selection is provided. Task forms and design-to-implementation handoffs offer platform checkboxes. Selection can be edited while the task is in Todo; the first start pins that scope with the workflow. Project defaults are not an allowlist, so an individual change can target any combination supported by the workflow. Later project-setting changes do not silently change existing tasks. Pipeline previews show only the selected steps even before starting. **Use latest workflow** refreshes the workflow definition while preserving the task’s pinned platform scope. Create a new task to use a different platform selection. BDD plans are durable job results and downloadable artifacts, separate from the implementation plan. Like other agent verification results, command evidence is reported by the agent; the server validates coverage and success, rather than independently executing native test tools.

## Deployment

Apply all migrations through `20261031173740_task_platform_selection.sql`, then deploy the server, shared package, web and worker together. Existing accounts receive an additive Mobile App SDLC template; edited workflows and the existing default remain unchanged. New accounts receive the template with the other bundled workflows.

Worker **0.4.0** uses protocol **6** because `bdd-plan` results and BDD/DDD verification evidence require the new worker contract. Older workers receive HTTP 426. The server checks database schema version `20261031173740` at startup. Supabase provisioning and credentials remain part of each app project's setup; creating a Sindral project does not provision a hosted backend or publish the app.

`20261031173740_task_platform_selection.sql` backfills existing mobile tasks from their pinned selection, or from project/workflow defaults for pending tasks. Non-mobile tasks retain null platform scope. The design-handoff RPC persists task platform selection in the same transaction as the task and frozen design input.
