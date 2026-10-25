# Claude Design workflows and portable sessions

Choose **Design an app** on Home to create a task using the **Claude Design** workflow. The Design tab pairs chat with exported previews, screen and viewport selection, revision history, approval, and implementation handoffs. Smaller screens switch between Design and Conversation panels.

## Deployment and account setup

Apply `20261025171114_portable_design_sessions.sql` and deploy the server, web app, shared package, and worker together. Worker **0.2.0** uses protocol **4**; older workers receive HTTP 426. Existing accounts receive the new bundled workflow through the migration; new accounts receive it during initial workflow seeding.

Design steps use the pinned `@anthropic-ai/claude-agent-sdk` and its bundled Claude executable. Other steps retain the configured CLI runner. On each machine:

1. Sign into Claude Code as the OS user running the worker. Refresh expired credentials. Artifact publishing requires a Claude account; API-key-only authentication is insufficient.
2. In a current interactive Claude Code installation, verify `/design` is available and the account's Design template is enabled. When Claude requests `/design consent`, the user must enter it themselves. Sindral does not grant consent or copy credentials between hosts.
3. If using `CLAUDE_CONFIG_DIR`, point it to the authenticated configuration. Keep SDK versions consistent across machines. The replacement machine needs the same account or an account with permission to edit the artifact.
4. Start the worker normally. Sindral invokes `/design` and explicitly enables artifacts for that SDK session, subject to account and organization policy. Missing access or login produces an error rather than a substitute mockup.

The live acceptance check is to create a design on worker A, submit feedback, replace A with a worker with an empty work directory, and revise the **same remote artifact**. Automated tests use deterministic engine and API fixtures; they do not establish live Claude account eligibility or export behavior.

## Portable conversation and files

The SDK mirrors opaque transcript entries eagerly through authenticated worker endpoints. Every operation checks the tenant, job attempt, lease token, cancellation flag, and expiry under a database row lock. Entries are deduplicated and loaded in order, including sidecar/subagent transcripts. Browsers cannot access these tables or the worker persistence RPC.

The stable project key is `sindral-task-<task UUID>`, independent of a machine's absolute paths. A replacement worker restores the transcript and exported workspace, then resumes the native session. Missing native history falls back explicitly to the saved conversation, specification, artifact link, and files. A workspace note supersedes old absolute paths in the transcript.

Files are checkpointed after tool-result messages, at most once per 15 seconds, and at turn completion. Recovery starts at the last saved checkpoint; an operation interrupted before it is saved may require reconciliation. Transcript or file persistence failures stop the design run. Local cleanup removes inactive cached designs and implementation inputs after the usual retention period without deleting the server copy.

Feedback received during generation is queued for the next turn instead of cancelling the external operation. Task job leases serialize turns. External Claude operations are outside Sindral's database transaction: after a crash, the worker must reconcile the existing artifact before repeating an operation.

## Preview and export contract

A completed revision contains the real Claude artifact URL, screen manifest, specification, questions, and exported files with SHA-256 hashes. Before creating a first artifact, a clarification turn can return questions without inventing a preview or URL.

Supported previews are self-contained HTML or PNG/JPEG/WebP/SVG artboards. HTML must inline CSS, JavaScript, and images; network-backed prototypes and server processes are unsupported. Source files and nested assets remain available for implementation. Limits are 100 files, 1 MB per file, 2.5 MB decoded total, 3.5 MB serialized files, and 3.8 MB per complete result. Oversized exports fail explicitly. Dependency folders and hidden configuration files are excluded; symlinks are rejected.

Previews use five-minute signed URLs scoped to one task, revision, and screen. The response has a separate CSP and sandbox with no parent-document access, forms, nested frames, or fetch/XHR/WebSocket access. The iframe omits `allow-same-origin`, sends no referrer, and is not cached. **Open in Claude** opens the external editor; Sindral does not embed native canvas editing.

## Approval and implementation handoff

Approval identifies an exact revision and checks the task's optimistic-concurrency version. The normal Finish design action requires approval of the current revision. Earlier approved revisions remain available for explicit handoff.

**Create implementation task** requires repositories and a workflow that implements code. Creation and snapshot storage are atomic and idempotent. The implementation owns a copy of the approved source, assets, specification, revision ID, checksums, and approval timestamp. Later revisions or deletion of the source task cannot change that copy.

Job claims carry only the handoff reference. The worker downloads its input through a lease-authorized endpoint, verifies hashes, and restores files under `design-inputs/<job UUID>`. Planning, implementation, review, and verification receive the same specification and file paths. This avoids large batches of claim responses on serverless deployments.

**Download handoff** exports a JSON bundle containing the specification and files; binary assets use base64. Implementation tasks display their frozen input in the Design tab, including after source deletion.

## Verification

Run `pnpm typecheck`, `pnpm test`, `pnpm db:test`, `pnpm lint`, `pnpm build`, and `pnpm test:e2e`. Coverage includes cross-worker restoration, tenant and lease fencing, queued feedback, preview isolation, revision approval, idempotent task creation, and retention after source deletion. Keep transcripts and files under the same private backup and retention controls as task data. Authenticate each worker independently; session restoration does not grant account access.

References: [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage), [artifact availability](https://code.claude.com/docs/en/artifacts#availability), and [Design commands and consent](https://code.claude.com/docs/en/commands).
