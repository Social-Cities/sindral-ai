# App design with Claude Code and portable sessions

Choose **Design an app** on Home to create a task using the **App Design** workflow. Claude Code creates interactive UI prototypes as files; Sindral displays them in the Design tab beside the conversation. Screen and viewport selection, revision history, approval, and implementation handoffs work without a hosted Claude artifact. Smaller screens switch between Design and Conversation panels.

## Deployment and authentication

Apply all migrations, including `20261025202507_claude_code_design_previews.sql`, and deploy the server, web app, shared package, and worker together. Worker **0.3.0** uses protocol **5**; older workers receive HTTP 426 because they require hosted Design artifacts and cannot collect previews without a URL.

The migration updates the original bundled Design prompts in saved workflows, active task snapshots, and pending jobs, including leased jobs that may be requeued during the upgrade. Workflow IDs, models, appended context, lease fields, and graph structure are preserved. Modified prompts are left alone; update customized workflows manually if they still require `/design` or artifact publishing. Completed task snapshots, saved conversations, approved revisions, and frozen handoffs are preserved. Existing hosted revisions keep their optional **Open in Claude** link.

Design steps use the pinned `@anthropic-ai/claude-agent-sdk`, which runs Claude Code's coding agent through its bundled executable. Other steps retain the configured CLI runner. On each machine:

1. Configure authentication supported by the Agent SDK for the OS user running the worker, such as `ANTHROPIC_API_KEY` in the worker process environment. Refresh expired credentials. There is no Design template, artifact publishing, or `/design` consent requirement.
2. If using `CLAUDE_CONFIG_DIR`, point it to the intended Claude configuration. Keep SDK versions consistent across machines. Authenticate replacement workers independently; Sindral never copies credentials between hosts.
3. Run `just start-worker` from the repository root. It installs the locked dependencies, builds, and starts the worker.

The live acceptance check is to create a design on worker A, interact with its preview in Sindral, submit feedback, replace A with an authenticated worker with an empty work directory, and revise the same saved prototype. Automated tests use deterministic engine and API fixtures; they do not establish live model quality or account access.

## Portable conversation and files

The SDK mirrors opaque transcript entries eagerly through authenticated worker endpoints. Every operation checks the tenant, job attempt, lease token, cancellation flag, and expiry under a database row lock. Entries are deduplicated and loaded in order, including sidecar/subagent transcripts. Browsers cannot access these tables or the worker persistence RPC.

The stable project key is `sindral-task-<task UUID>`, independent of a machine's absolute paths. A replacement worker restores the transcript and design workspace, then resumes the native session. Missing native history falls back explicitly to the saved conversation, specification, and files. A workspace note supersedes old absolute paths in the transcript.

Files are checkpointed after tool-result messages, at most once per 15 seconds, and at turn completion. Recovery starts at the last saved checkpoint; an operation interrupted before it is saved may require reconciliation. Transcript or file persistence failures stop the design run. Local cleanup removes inactive cached designs and implementation inputs after the usual retention period without deleting the server copy.

Feedback received during generation is queued for the next turn instead of cancelling the operation. Task job leases serialize turns. After a crash, the worker inspects restored files before repeating work.

## Preview and export contract

A completed revision contains a screen manifest, implementation specification, questions, and source/preview files with SHA-256 hashes. `designUrl` is normally null and is retained only for compatibility with earlier hosted revisions. A revision is identified by its preview screens, not an external URL.

A clarification-only turn returns nonempty questions, no screens or result files, and a null URL. It does not replace the current revision. The workspace and conversation are still checkpointed, so existing preview files survive for the next turn.

Supported previews are self-contained HTML or PNG/JPEG/WebP/SVG artboards. HTML must inline CSS, JavaScript, fonts, and images; network-backed prototypes, external scripts, relative asset requests, build steps, and server processes are unsupported. Interactions run inside each standalone screen; the Sindral screen picker switches preview files. Source files and nested assets remain available for implementation. Limits are 100 files, 1 MB per file, 2.5 MB decoded total, 3.5 MB serialized files, and 3.8 MB per complete result. Oversized exports fail explicitly. Dependency folders and hidden configuration files are excluded; symlinks are rejected.

Previews use five-minute signed URLs scoped to one task, revision, and screen. The response has a separate CSP and sandbox with no parent-document access, forms, nested frames, or fetch/XHR/WebSocket access. The iframe omits `allow-same-origin`, sends no referrer, and is not cached. Give feedback in the conversation to change a design; Sindral does not provide direct canvas editing.

## Approval and implementation handoff

Approval identifies an exact revision and checks the task's optimistic-concurrency version. The normal Finish design action requires approval of the current revision. Earlier approved revisions remain available for explicit handoff.

**Create implementation task** requires repositories and a workflow that implements code. Creation and snapshot storage are atomic and idempotent. The implementation owns a copy of the approved source, assets, specification, revision ID, checksums, and approval timestamp. Later revisions or deletion of the source task cannot change that copy.

Job claims carry only the handoff reference. The worker downloads its input through a lease-authorized endpoint, verifies hashes, and restores files under `design-inputs/<job UUID>`. Planning, implementation, review, and verification receive the same specification and file paths. This avoids large batches of claim responses on serverless deployments.

**Download handoff** exports a JSON bundle containing the specification and files; binary assets use base64. Implementation tasks display their frozen input in the Design tab, including after source deletion.

## Verification

Run `pnpm typecheck`, `pnpm test`, `pnpm db:test`, `pnpm lint`, `pnpm build`, and `pnpm test:e2e`. Coverage includes preview-only designs, legacy hosted links, clarification turns, cross-worker restoration, workflow migration, tenant and lease fencing, queued feedback, preview isolation, revision approval, idempotent task creation, and retention after source deletion. Keep transcripts and files under the same private backup and retention controls as task data. Authenticate each worker independently; session restoration does not grant account access.

References: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [SDK authentication](https://code.claude.com/docs/en/agent-sdk/quickstart), and [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage).
