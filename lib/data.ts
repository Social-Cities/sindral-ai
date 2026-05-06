export type AgentStatus = "working" | "online" | "idle";
export type AgentRole = "planner" | "implementer" | "reviewer";

export interface Teammate {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  hue: number;
  status: AgentStatus;
  task: string | null;
}

export interface Human {
  id: string;
  name: string;
  hue: number;
  short: string;
}

export interface Project {
  id: string;
  name: string;
  repo: string;
  emoji: string;
  open: number;
  planning: number;
  inProgress: number;
  prOpen: number;
  active: boolean;
}

export type TaskType = "feature" | "bug" | "chore" | "refactor" | "spike" | "docs";
export type TaskState =
  | "backlog"
  | "planning"
  | "planReady"
  | "inProgress"
  | "prOpen"
  | "merged"
  | "blocked";
export type TaskPriority = "high" | "med" | "low";

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  state: TaskState;
  agent: string | null;
  assignee: string | null;
  branch: string | null;
  updated: string;
  priority: TaskPriority;
}

export interface PlanMessage {
  id: string;
  from: string;
  kind: "msg" | "event" | "tool";
  t?: string;
  text: string;
}

export type DiffRowType = "hunk" | "ctx" | "add" | "del";
export interface DiffRow {
  type: DiffRowType;
  oldNum?: number | string;
  newNum?: number | string;
  text: string;
}
export interface DiffFile {
  path: string;
  add: number;
  del: number;
  hunks: DiffRow[];
}

export interface ActivityItem {
  id: string;
  who: string;
  verb: string;
  target: string;
  detail: string;
  t: string;
}

export const TEAMMATES: Teammate[] = [
  { id: "a1", name: "Iris", role: "planner", model: "claude-haiku-5", hue: 268, status: "working", task: "AGT-142" },
  { id: "a2", name: "Atlas", role: "implementer", model: "codex-2", hue: 18, status: "working", task: "AGT-138" },
  { id: "a3", name: "Juno", role: "implementer", model: "claude-haiku-5", hue: 142, status: "online", task: null },
  { id: "a4", name: "Echo", role: "reviewer", model: "claude-haiku-5", hue: 220, status: "online", task: null },
  { id: "a5", name: "Pax", role: "planner", model: "codex-2", hue: 340, status: "idle", task: null },
];

export const HUMANS: Human[] = [
  { id: "h1", name: "You", hue: 30, short: "Y" },
  { id: "h2", name: "Mira Cho", hue: 200, short: "MC" },
  { id: "h3", name: "Sam Park", hue: 80, short: "SP" },
];

export const PROJECTS: Project[] = [
  { id: "p1", name: "kettle", repo: "agatha/kettle", emoji: "🫖", open: 14, planning: 2, inProgress: 3, prOpen: 1, active: true },
  { id: "p2", name: "beacon-api", repo: "agatha/beacon-api", emoji: "◐", open: 6, planning: 0, inProgress: 1, prOpen: 2, active: false },
  { id: "p3", name: "lattice", repo: "agatha/lattice", emoji: "◇", open: 21, planning: 1, inProgress: 0, prOpen: 0, active: false },
];

export const TASK_TYPES: Record<TaskType, { label: string; color: string }> = {
  feature: { label: "Feature", color: "var(--type-feature)" },
  bug: { label: "Bug", color: "var(--type-bug)" },
  chore: { label: "Chore", color: "var(--type-chore)" },
  refactor: { label: "Refactor", color: "var(--type-refactor)" },
  spike: { label: "Spike", color: "var(--type-spike)" },
  docs: { label: "Docs", color: "var(--type-docs)" },
};

export const TASK_STATES: Record<TaskState, { label: string; color: string; order: number }> = {
  backlog: { label: "Backlog", color: "var(--status-backlog)", order: 0 },
  planning: { label: "Planning", color: "var(--status-planning)", order: 1 },
  planReady: { label: "Plan ready", color: "var(--status-plan-ready)", order: 2 },
  inProgress: { label: "In progress", color: "var(--status-in-progress)", order: 3 },
  prOpen: { label: "PR open", color: "var(--status-pr-open)", order: 4 },
  merged: { label: "Merged", color: "var(--status-merged)", order: 5 },
  blocked: { label: "Blocked", color: "var(--status-blocked)", order: 6 },
};

export const TASKS: Task[] = [
  { id: "AGT-142", type: "feature", title: "Streaming SSE proxy for /v1/messages with backpressure", state: "planning", agent: "a1", assignee: "h1", branch: null, updated: "2m", priority: "high" },
  { id: "AGT-138", type: "feature", title: "Replace polling worker queue with Postgres LISTEN/NOTIFY", state: "inProgress", agent: "a2", assignee: "h2", branch: "atlas/listen-notify", updated: "14m", priority: "high" },
  { id: "AGT-140", type: "bug", title: "Race condition in branch cleanup when worker crashes mid-PR", state: "prOpen", agent: "a3", assignee: "h1", branch: "juno/branch-cleanup-race", updated: "1h", priority: "high" },
  { id: "AGT-139", type: "refactor", title: "Extract sandbox lifecycle into its own crate", state: "planReady", agent: "a5", assignee: null, branch: null, updated: "3h", priority: "med" },
  { id: "AGT-141", type: "chore", title: "Bump tokio to 1.39, drop deprecated time helpers", state: "backlog", agent: null, assignee: null, branch: null, updated: "5h", priority: "low" },
  { id: "AGT-137", type: "spike", title: "Investigate per-task sandbox snapshot for instant resume", state: "backlog", agent: null, assignee: "h2", branch: null, updated: "1d", priority: "med" },
  { id: "AGT-136", type: "docs", title: "Document the worker→agent handshake protocol", state: "backlog", agent: null, assignee: null, branch: null, updated: "1d", priority: "low" },
  { id: "AGT-135", type: "bug", title: "PR diff viewer scrolls past file boundary on large hunks", state: "merged", agent: "a3", assignee: "h3", branch: "juno/diff-scroll", updated: "2d", priority: "med" },
  { id: "AGT-134", type: "feature", title: "Add @-mention triggers in plan composer for file refs", state: "merged", agent: "a2", assignee: "h1", branch: "atlas/at-mention", updated: "3d", priority: "med" },
];

export const PLAN_AGT142 = `# Streaming SSE proxy for \`/v1/messages\` with backpressure

## Context

The current proxy in [[server/src/routes/messages.rs]] buffers the entire upstream response before sending it to the client. For long-running tool-use sessions this introduces 8–40s of perceived latency and risks OOM on the worker pod when many sessions stream simultaneously.

We want a passthrough proxy that streams tokens as they arrive, with **per-connection backpressure** so a slow client cannot pin upstream tokens in memory.

## Goals

- End-to-end streaming with first-token latency under 200ms
- Bounded memory: at most 64KB per connection in flight
- Graceful client disconnect: cancel upstream within 1 RTT
- Preserve current auth and rate-limit middleware

## Non-goals

- Replacing the upstream HTTP client (still \`reqwest\`)
- Changing the public SSE event shape

## Design

### 1. Wire up a streaming response body

Replace the \`Json<MessagesResponse>\` return with an [[axum::body::Body]] built from a \`Stream<Item = Result<Bytes, _>>\`. The handler signature becomes:

\`\`\`rust
pub async fn messages(
    State(ctx): State<AppCtx>,
    Json(req): Json<MessagesRequest>,
) -> Result<Response, ApiError> {
    let upstream = ctx.client.post(UPSTREAM).json(&req).send().await?;
    let stream = upstream.bytes_stream().map_err(ApiError::from);
    let body = Body::from_stream(stream);
    Ok(Response::builder()
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(body)?)
}
\`\`\`

### 2. Backpressure via bounded mpsc

Wrap the bytes_stream in a \`tokio::sync::mpsc::channel(8)\` so upstream reads pause when the downstream socket is slow. Drop the upstream connection if the receiver closes.

### 3. Cancel on client disconnect

Use [[axum::extract::ConnectInfo]] paired with \`tokio::select!\` on \`req.closed()\` to abort the upstream future when the client drops.

## Files affected

- [[server/src/routes/messages.rs]] — new streaming handler
- [[server/src/middleware/ratelimit.rs]] — must release token at *connection close*, not response start
- [[server/src/error.rs]] — add \`ApiError::UpstreamStream\`

## Test plan

1. Unit: synthetic upstream emits 100 events; assert each arrives at client within 50ms of upstream send
2. Unit: slow client (1KB/s) — upstream connection holds <64KB resident
3. Integration: \`scripts/load-stream.sh\` — 200 concurrent streams, p99 first-token <300ms
4. Manual: kill client mid-stream, confirm upstream socket closes within 200ms

## Open questions

> Should we expose an event id on each chunk so clients can resume after disconnect?

I'd punt this to a follow-up — needs upstream cooperation and isn't required for the immediate latency fix.`;

export const STREAMING_PARTIAL = `# Streaming SSE proxy for \`/v1/messages\` with backpressure

## Context

The current proxy in [[server/src/routes/messages.rs]] buffers the entire upstream response before sending it to the client. For long-running tool-use sessions this introduces 8–40s of perceived latency and risks OOM on the worker pod when many sessions stream simultaneously.

We want a passthrough proxy that streams tokens as they arrive, with **per-connection backpressure** so a slow client cannot pin upstream tokens in memory.

## Goals

- End-to-end streaming with first-token latency under 200ms
- Bounded memory: at most 64KB per connection in flight
- Graceful client disconnect: cancel upstream within 1 RTT`;

export const PLAN_MESSAGES_AGT142: PlanMessage[] = [
  { id: "m1", from: "h1", kind: "msg", t: "14:02", text: "Build a streaming SSE proxy for /v1/messages. The current one buffers everything which kills latency for long tool-use sessions." },
  { id: "m2", from: "a1", kind: "event", text: "Iris reading the repo" },
  { id: "m3", from: "a1", kind: "tool", text: 'grep "/v1/messages" in server/src/' },
  { id: "m4", from: "a1", kind: "tool", text: "read server/src/routes/messages.rs (142 lines)" },
  { id: "m5", from: "a1", kind: "tool", text: "read server/src/middleware/ratelimit.rs" },
  { id: "m6", from: "a1", kind: "msg", t: "14:04", text: "I see — the current handler awaits the full response before returning. I'll draft a plan that moves to a streaming body with bounded backpressure. One thing I want to flag: the rate-limit middleware releases tokens on response *start*, which means streaming responses will leak tokens. Should I include the fix in this plan or split it out?" },
  { id: "m7", from: "h1", kind: "msg", t: "14:05", text: "Include it. Same PR." },
  { id: "m8", from: "a1", kind: "event", text: "Iris is drafting the plan" },
];

export const PR_AGT138_FILES: DiffFile[] = [
  {
    path: "server/src/queue/mod.rs",
    add: 38, del: 64,
    hunks: [
      { type: "hunk", text: "@@ -1,12 +1,18 @@" },
      { type: "ctx", oldNum: 1, newNum: 1, text: "use crate::db::PgPool;" },
      { type: "ctx", oldNum: 2, newNum: 2, text: "use crate::task::Task;" },
      { type: "del", oldNum: 3, newNum: "", text: "use std::time::Duration;" },
      { type: "del", oldNum: 4, newNum: "", text: "use tokio::time::sleep;" },
      { type: "add", oldNum: "", newNum: 3, text: "use sqlx::postgres::PgListener;" },
      { type: "ctx", oldNum: 5, newNum: 4, text: "" },
      { type: "del", oldNum: 6, newNum: "", text: "const POLL_INTERVAL: Duration = Duration::from_millis(250);" },
      { type: "ctx", oldNum: 7, newNum: 5, text: "" },
      { type: "ctx", oldNum: 8, newNum: 6, text: "pub struct Worker {" },
      { type: "ctx", oldNum: 9, newNum: 7, text: "    pool: PgPool," },
      { type: "add", oldNum: "", newNum: 8, text: "    listener: PgListener," },
      { type: "ctx", oldNum: 10, newNum: 9, text: "    id: WorkerId," },
      { type: "ctx", oldNum: 11, newNum: 10, text: "}" },
      { type: "hunk", text: "@@ -34,28 +40,18 @@ impl Worker {" },
      { type: "ctx", oldNum: 34, newNum: 40, text: "    pub async fn run(mut self) -> Result<()> {" },
      { type: "del", oldNum: 35, newNum: "", text: "        loop {" },
      { type: "del", oldNum: 36, newNum: "", text: "            match self.try_claim_next().await? {" },
      { type: "del", oldNum: 37, newNum: "", text: "                Some(task) => self.execute(task).await?," },
      { type: "del", oldNum: 38, newNum: "", text: "                None => sleep(POLL_INTERVAL).await," },
      { type: "del", oldNum: 39, newNum: "", text: "            }" },
      { type: "del", oldNum: 40, newNum: "", text: "        }" },
      { type: "add", oldNum: "", newNum: 41, text: '        self.listener.listen("task_enqueued").await?;' },
      { type: "add", oldNum: "", newNum: 42, text: "        loop {" },
      { type: "add", oldNum: "", newNum: 43, text: "            // Drain any tasks already queued before we listened." },
      { type: "add", oldNum: "", newNum: 44, text: "            while let Some(task) = self.try_claim_next().await? {" },
      { type: "add", oldNum: "", newNum: 45, text: "                self.execute(task).await?;" },
      { type: "add", oldNum: "", newNum: 46, text: "            }" },
      { type: "add", oldNum: "", newNum: 47, text: "            // Block on the next NOTIFY." },
      { type: "add", oldNum: "", newNum: 48, text: "            self.listener.recv().await?;" },
      { type: "add", oldNum: "", newNum: 49, text: "        }" },
      { type: "ctx", oldNum: 41, newNum: 50, text: "    }" },
    ],
  },
  {
    path: "server/migrations/0014_task_notify.sql",
    add: 14, del: 0,
    hunks: [
      { type: "hunk", text: "@@ -0,0 +1,14 @@" },
      { type: "add", oldNum: "", newNum: 1, text: "-- Notify workers when a task is enqueued." },
      { type: "add", oldNum: "", newNum: 2, text: "CREATE OR REPLACE FUNCTION notify_task_enqueued()" },
      { type: "add", oldNum: "", newNum: 3, text: "RETURNS TRIGGER AS $$" },
      { type: "add", oldNum: "", newNum: 4, text: "BEGIN" },
      { type: "add", oldNum: "", newNum: 5, text: "    PERFORM pg_notify('task_enqueued', NEW.id::text);" },
      { type: "add", oldNum: "", newNum: 6, text: "    RETURN NEW;" },
      { type: "add", oldNum: "", newNum: 7, text: "END;" },
      { type: "add", oldNum: "", newNum: 8, text: "$$ LANGUAGE plpgsql;" },
      { type: "add", oldNum: "", newNum: 9, text: "" },
      { type: "add", oldNum: "", newNum: 10, text: "CREATE TRIGGER task_enqueued_notify" },
      { type: "add", oldNum: "", newNum: 11, text: "AFTER INSERT ON tasks" },
      { type: "add", oldNum: "", newNum: 12, text: "FOR EACH ROW" },
      { type: "add", oldNum: "", newNum: 13, text: "WHEN (NEW.state = 'queued')" },
      { type: "add", oldNum: "", newNum: 14, text: "EXECUTE FUNCTION notify_task_enqueued();" },
    ],
  },
  {
    path: "server/src/queue/tests.rs",
    add: 22, del: 8,
    hunks: [
      { type: "hunk", text: "@@ -42,8 +42,22 @@ async fn worker_picks_up_enqueued_task() {" },
      { type: "ctx", oldNum: 42, newNum: 42, text: "    let pool = test_pool().await;" },
      { type: "ctx", oldNum: 43, newNum: 43, text: "    let worker = Worker::new(pool.clone(), WorkerId::new()).await?;" },
      { type: "del", oldNum: 44, newNum: "", text: '    enqueue(&pool, "noop").await?;' },
      { type: "del", oldNum: 45, newNum: "", text: "    sleep(Duration::from_millis(500)).await;" },
      { type: "add", oldNum: "", newNum: 44, text: "    let handle = tokio::spawn(worker.run());" },
      { type: "add", oldNum: "", newNum: 45, text: '    enqueue(&pool, "noop").await?;' },
      { type: "add", oldNum: "", newNum: 46, text: "    // Should pick up within 50ms now (was 250ms p50 with polling)." },
      { type: "add", oldNum: "", newNum: 47, text: "    wait_until_done(&pool, Duration::from_millis(100)).await?;" },
      { type: "ctx", oldNum: 46, newNum: 48, text: "    assert_eq!(completed_count(&pool).await?, 1);" },
      { type: "add", oldNum: "", newNum: 49, text: "    handle.abort();" },
      { type: "ctx", oldNum: 47, newNum: 50, text: "}" },
    ],
  },
];

export const PR_AGT138_MESSAGES: PlanMessage[] = [
  { id: "p1", from: "a2", kind: "event", text: "Atlas opened branch atlas/listen-notify" },
  { id: "p2", from: "a2", kind: "tool", text: "edit server/src/queue/mod.rs (+38 −64)" },
  { id: "p3", from: "a2", kind: "tool", text: "create server/migrations/0014_task_notify.sql" },
  { id: "p4", from: "a2", kind: "tool", text: "cargo test -p server queue:: → 12 passed" },
  { id: "p5", from: "a2", kind: "msg", t: "13:48", text: "Plan implemented. The polling loop is gone — workers now LISTEN on `task_enqueued` and drain on every NOTIFY. I added the trigger as a migration. P50 pickup latency in the new test goes from ~125ms to ~3ms.\n\nOne thing I want a human eye on: I'm draining *before* listening, which means if a task is enqueued during the drain it gets a notification we don't strictly need. Harmless but worth noting." },
  { id: "p6", from: "h2", kind: "msg", t: "13:55", text: "Looks good. Can you also bump the connection pool min size? With LISTEN we'll hold one conn per worker permanently." },
  { id: "p7", from: "a2", kind: "event", text: "Atlas is updating the PR" },
  { id: "p8", from: "a2", kind: "tool", text: "edit server/src/db.rs (+2 −1)" },
];

export const ACTIVITY: ActivityItem[] = [
  { id: "f1", who: "a2", verb: "pushed 2 commits to", target: "AGT-138", detail: "atlas/listen-notify", t: "4m" },
  { id: "f2", who: "h2", verb: "commented on", target: "AGT-138", detail: "Can you also bump the connection pool…", t: "11m" },
  { id: "f3", who: "a1", verb: "is drafting a plan for", target: "AGT-142", detail: "Streaming SSE proxy", t: "12m" },
  { id: "f4", who: "a3", verb: "opened PR for", target: "AGT-140", detail: "#284 — Race condition in branch cleanup", t: "1h" },
  { id: "f5", who: "h1", verb: "created", target: "AGT-142", detail: "Streaming SSE proxy for /v1/messages", t: "1h" },
  { id: "f6", who: "a3", verb: "merged", target: "AGT-135", detail: "PR diff viewer scrolls past file boundary", t: "2d" },
];
