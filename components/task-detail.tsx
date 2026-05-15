"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Markdown, StatusPill, TypePill, renderInline } from "./atoms";
import { I } from "./icons";
import { useTeammate, useTeammates, usePerson } from "./providers/people-context";
import { AssignWorkerModal } from "./modals";
import { sendChatMessageAction } from "@/lib/actions/chat";
import { cancelJobAction } from "@/lib/actions/jobs";
import { updateTaskMemoryAction } from "@/lib/actions/memory";
import { RUNTIME_KINDS } from "@/lib/data";
import type {
  ChatChannel,
  DiffFile,
  PlanMessage,
  Task,
  TaskConversationMessage,
  TaskJob,
  TaskJobStatus,
  TaskMemory,
  TaskPlan,
} from "@/lib/data";

type Mode = "plan" | "pr" | "thread" | "chat" | "jobs" | "memory";

const STATUS_TONE: Record<TaskJobStatus, string> = {
  queued: "var(--text-muted)",
  dispatching: "var(--accent)",
  running: "var(--accent)",
  succeeded: "var(--diff-add-line)",
  failed: "var(--type-bug)",
  cancelled: "var(--text-faint)",
};

function TaskHeader({
  task,
  mode,
  setMode,
  backHref,
  hasPr,
}: {
  task: Task;
  mode: Mode;
  setMode: (m: Mode) => void;
  backHref: string;
  hasPr: boolean;
}) {
  const tabs: { id: Mode; label: string; show: boolean }[] = [
    { id: "plan", label: "Plan", show: true },
    { id: "pr", label: "PR", show: hasPr },
    { id: "chat", label: "Chat", show: true },
    { id: "jobs", label: "Jobs", show: true },
    { id: "memory", label: "Memory", show: true },
    { id: "thread", label: "Thread", show: true },
  ];
  return (
    <div style={{ borderBottom: "1px solid var(--line)", padding: "14px 22px 0", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Link className="btn ghost sm" href={backHref}>← Back</Link>
        <span className="task-id" style={{ fontSize: 12 }}>{task.id}</span>
        <TypePill type={task.type} />
        <StatusPill state={task.state} />
        {task.runtime && (
          <span
            className="muted"
            style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}
            title={`Runtime: ${RUNTIME_KINDS[task.runtime].label}`}
          >
            · {RUNTIME_KINDS[task.runtime].label}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {task.branch && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <I.branch />
            {task.branch}
          </span>
        )}
        <button className="btn ghost sm"><I.comment /></button>
        <button className="btn sm">Share</button>
      </div>

      <div
        style={{
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontSize: 26,
          fontWeight: 400,
          letterSpacing: "-0.01em",
          lineHeight: 1.2,
          marginBottom: 10,
        }}
      >
        {task.title}
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <div
              key={t.id}
              className={`page-tab ${mode === t.id ? "active" : ""}`}
              onClick={() => setMode(t.id)}
              style={{ marginBottom: -1 }}
            >
              {t.label}
            </div>
          ))}
      </div>
    </div>
  );
}

function Msg({ m }: { m: PlanMessage }) {
  const person = usePerson(m.from);
  if (m.kind === "event") {
    return (
      <div className="msg-event">
        <span className="ev-dot" />
        <span className="ev-text">{m.text}</span>
        <span className="ev-line" />
      </div>
    );
  }
  if (m.kind === "tool") {
    return (
      <div className="msg-tool">
        <span className="tool-ico">
          {m.text.startsWith("read") ? <I.file /> : m.text.startsWith("edit") ? <I.edit /> : m.text.startsWith("create") ? <I.plus /> : <I.terminal />}
        </span>
        <span>{m.text}</span>
      </div>
    );
  }
  const isAgent = person && "role" in person;
  const name = person?.name;
  return (
    <div className="msg">
      <Avatar who={m.from} />
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{name}</span>
          {isAgent && (
            <span className="muted" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>· {person.model}</span>
          )}
          <span className="msg-time">{m.t}</span>
        </div>
        <div className="msg-text">
          {m.text.split("\n\n").map((p, i) => (
            <p key={i}>{renderInline(p, i)}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatPanel({
  messages,
  agent,
  placeholder,
  sideTabs = ["Chat", "Activity"],
}: {
  messages: PlanMessage[];
  agent: string;
  placeholder?: string;
  sideTabs?: string[];
}) {
  const [text, setText] = useState("");
  const [activeTab, setActiveTab] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  const send = () => {
    if (!text.trim()) return;
    setText("");
  };

  const teammate = useTeammate(agent);

  return (
    <div className="side">
      <div className="side-head">
        <Avatar who={agent} size="sm" showStatus />
        <span>{teammate?.name}</span>
        <span className="muted" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)" }}>{teammate?.model}</span>
        <div className="side-tabs">
          {sideTabs.map((t, i) => (
            <span key={i} className={`side-tab ${activeTab === i ? "active" : ""}`} onClick={() => setActiveTab(i)}>
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="chat" style={{ flex: 1, minHeight: 0 }}>
        <div className="chat-msgs" ref={scrollRef}>
          {messages.map((m) => (
            <Msg key={m.id} m={m} />
          ))}
        </div>
        <div className="composer">
          <textarea
            placeholder={placeholder || "Reply to the agent…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
          />
          <div className="composer-row">
            <button className="btn ghost sm" title="Mention file"><I.hash /></button>
            <button className="btn ghost sm" title="Attach"><I.file /></button>
            <div className="composer-spacer" />
            <span className="muted" style={{ fontSize: 11 }}>⌘↵ to send</span>
            <button className="btn primary sm" onClick={send} disabled={!text.trim()}>
              <I.send />Reply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat tab — task_conversations-backed conversation between human + persona.
// Uses a server action to send and revalidates the page so new messages
// (including the persona's reply written by the workflow) flow back in.
// ---------------------------------------------------------------------------

function ChatTab({
  task,
  projectId,
  initialMessages,
  defaultChannel,
}: {
  task: Task;
  projectId: string;
  initialMessages: TaskConversationMessage[];
  defaultChannel: ChatChannel;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<ChatChannel>(defaultChannel);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = initialMessages.filter((m) => m.channel === channel);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, channel]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setError(null);
    startTransition(async () => {
      const r = await sendChatMessageAction({
        taskId: task.id,
        channel,
        message: trimmed,
        projectId,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setText("");
      router.refresh();
    });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "16px 22px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <button
          className="btn sm"
          onClick={() => setChannel("plan")}
          style={
            channel === "plan"
              ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
              : {}
          }
        >
          Plan chat
        </button>
        <button
          className="btn sm"
          onClick={() => setChannel("implementation")}
          style={
            channel === "implementation"
              ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
              : {}
          }
        >
          Implementation chat
        </button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8, alignSelf: "center" }}>
          {messages.length} messages
        </span>
      </div>

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 12 }}>
        {messages.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No messages yet. Send the persona a question or steer their work below.
          </div>
        ) : (
          messages.map((m) => <ConversationRow key={m.id} m={m} />)
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <textarea
          className="field-input"
          rows={3}
          placeholder={
            channel === "plan"
              ? "Ask the planner to refine the plan…"
              : "Ask the implementer about the change…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
        {error && (
          <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginTop: 6 }}>{error}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 11 }}>⌘↵ to send</span>
          <button className="btn primary sm" onClick={send} disabled={!text.trim() || pending}>
            {pending ? "Sending…" : (<><I.send />Send</>)}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConversationRow({ m }: { m: TaskConversationMessage }) {
  const person = usePerson(m.fromId);
  const name =
    person?.name ?? (m.fromKind === "system" ? "System" : m.fromId.slice(0, 8));
  return (
    <div className="msg">
      <Avatar who={m.fromId} />
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{name}</span>
          <span className="muted" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
            · {m.fromKind}
          </span>
          <span className="msg-time">
            {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <div className="msg-text">
          {m.message.split("\n\n").map((p, i) => (
            <p key={i}>{renderInline(p, i)}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs tab — durable plan/implement attempts and their event timelines.
// ---------------------------------------------------------------------------

function JobsTab({
  task,
  projectId,
  jobs,
}: {
  task: Task;
  projectId: string;
  jobs: TaskJob[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cancel = (jobId: string) => {
    setError(null);
    startTransition(async () => {
      const r = await cancelJobAction({ jobId, taskId: task.id, projectId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, padding: "16px 22px", overflowY: "auto" }}>
      {error && (
        <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginBottom: 12 }}>{error}</div>
      )}
      {jobs.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No jobs yet. Jobs are created when a planner or implementer starts work on this task.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {jobs.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              onCancel={() => cancel(j.id)}
              cancelling={pending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({
  job,
  onCancel,
  cancelling,
}: {
  job: TaskJob;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const person = usePerson(job.personaId);
  const isTerminal =
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled";
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Avatar who={job.personaId} size="sm" />
        <div style={{ fontWeight: 500, fontSize: 13.5 }}>
          {person?.name ?? job.personaId.slice(0, 8)}{" "}
          <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            · {job.jobType}
          </span>
        </div>
        <span
          style={{
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            color: STATUS_TONE[job.status],
            border: `1px solid ${STATUS_TONE[job.status]}`,
            borderRadius: 4,
            padding: "2px 6px",
          }}
        >
          {job.status}
        </span>
        <span className="muted" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)" }}>
          {RUNTIME_KINDS[job.runtime].label}
        </span>
        <div style={{ flex: 1 }} />
        {!isTerminal && (
          <button className="btn ghost sm" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        attempt {job.attempt} · created {new Date(job.createdAt).toLocaleString()}
        {job.workflowId && (
          <>
            {" · "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{job.workflowId}</span>
          </>
        )}
      </div>
      {job.lastError && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--type-bug)" }}>
          {job.lastError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory tab — view + edit the per-task agent memory rollup. The
// summarizer writes into the same record from the worker; human edits
// flip human_edited=true so the next summarize preserves their phrasing.
// ---------------------------------------------------------------------------

function MemoryTab({
  task,
  projectId,
  memory,
}: {
  task: Task;
  projectId: string;
  memory: TaskMemory | null;
}) {
  const router = useRouter();
  const initialText = memory?.rollupMarkdown ?? "";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    startTransition(async () => {
      const r = await updateTaskMemoryAction({
        taskId: task.id,
        rollupMarkdown: text,
        projectId,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  const cancel = () => {
    setText(initialText);
    setEditing(false);
    setError(null);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, padding: "16px 22px", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontWeight: 500 }}>Agent memory</div>
        {memory?.humanEdited && (
          <span
            className="muted"
            style={{
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              border: "1px solid var(--accent-soft)",
              color: "var(--accent)",
              borderRadius: 4,
              padding: "2px 6px",
            }}
          >
            human-edited
          </span>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          {memory ? `~${memory.rollupTokens} tokens` : "no memory yet"}
          {memory?.lastSummarizedAt && (
            <> · last summarized {new Date(memory.lastSummarizedAt).toLocaleString()}</>
          )}
        </span>
        <div style={{ flex: 1 }} />
        {!editing && (
          <button className="btn sm" onClick={() => setEditing(true)} disabled={!memory && initialText === ""}>
            <I.edit />Edit
          </button>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12, maxWidth: 720 }}>
        This rollup is loaded into the system prompt of every plan, implement, and chat
        call for this task. It&apos;s rewritten by a small model after each phase; if you
        edit it, future runs preserve your phrasing.
      </div>

      {editing ? (
        <>
          <textarea
            className="field-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={20}
            style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12.5, width: "100%" }}
          />
          {error && (
            <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginTop: 8 }}>{error}</div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn ghost sm" onClick={cancel} disabled={pending}>
              Cancel
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn primary sm" onClick={save} disabled={pending || text === initialText}>
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : initialText.trim() ? (
        <div
          style={{
            padding: 16,
            border: "1px solid var(--line)",
            borderRadius: 8,
            background: "var(--accent-softer)",
          }}
        >
          <Markdown text={initialText} />
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          No memory recorded yet. The summarizer will populate this after the first plan
          or chat exchange.
        </div>
      )}
    </div>
  );
}

function PlanView({
  task,
  projectId,
  plan,
  messages,
  sidebarLayout,
}: {
  task: Task;
  projectId: string;
  plan: TaskPlan | null;
  messages: PlanMessage[];
  sidebarLayout: "default" | "compact";
}) {
  const isStreaming = task.state === "planning";
  const fullText = plan?.markdown ?? "";
  const partialLen = plan?.streamingPartial?.length ?? 0;
  const [streamPos, setStreamPos] = useState(isStreaming ? partialLen : fullText.length);
  const [paused, setPaused] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const planAgentId = task.agent;
  const planAgent = useTeammate(planAgentId);

  useEffect(() => {
    if (!isStreaming || paused) return;
    if (streamPos >= fullText.length) return;
    const id = setInterval(() => {
      setStreamPos((p) => Math.min(p + Math.floor(2 + Math.random() * 5), fullText.length));
    }, 35);
    return () => clearInterval(id);
  }, [isStreaming, paused, streamPos, fullText.length]);

  const visibleText = isStreaming ? fullText.slice(0, streamPos) : fullText;
  const done = streamPos >= fullText.length;
  const canAssign =
    !isStreaming &&
    (task.state === "planReady" || task.state === "backlog" || task.state === "blocked");

  if (!fullText) {
    return (
      <div className={`plan-layout ${sidebarLayout === "compact" ? "compact-side" : ""}`}>
        <div className="plan-doc">
          <div className="plan-doc-inner" style={{ color: "var(--text-muted)" }}>
            No plan yet for this task.
          </div>
        </div>
        {planAgentId && (
          <ChatPanel
            messages={messages}
            agent={planAgentId}
            placeholder="Ask the planner to draft a plan…"
          />
        )}
      </div>
    );
  }

  return (
    <div className={`plan-layout ${sidebarLayout === "compact" ? "compact-side" : ""}`} data-screen-label="Task — Plan">
      <div className="plan-doc">
        <div className="plan-doc-inner">
          <div className="plan-doc-head">
            <div className="plan-doc-meta">
              {isStreaming && !done ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 50, background: "var(--accent)", animation: "pulse 1s infinite" }} />
                  {planAgent?.name ?? "Planner"} is drafting the plan
                </span>
              ) : planAgentId ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Avatar who={planAgentId} size="sm" />
                  <span>Drafted by {planAgent?.name}</span>
                </span>
              ) : null}
              <span className="faint">·</span>
              <span className="muted">{Math.round(visibleText.length / 5)} words</span>
              {isStreaming && !done && (
                <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setPaused((p) => !p)}>
                  {paused ? "Resume" : <><I.pause />Pause</>}
                </button>
              )}
              {(!isStreaming || done) && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className="btn sm"><I.edit />Edit</button>
                  <button
                    className="btn primary sm"
                    onClick={() => setShowAssign(true)}
                    disabled={!canAssign}
                  >
                    Assign worker<I.arrowR />
                  </button>
                </div>
              )}
            </div>
          </div>
          <Markdown text={visibleText} streaming={isStreaming && !done && !paused} />

          {(!isStreaming || done) && canAssign && (
            <div
              className="card stream-in"
              style={{
                marginTop: 28,
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                gap: 14,
                background: "var(--accent-softer)",
                borderColor: "var(--accent-soft)",
              }}
            >
              <I.sparkle />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>Plan ready for review</div>
                <div className="muted" style={{ fontSize: 12.5 }}>Refine in the chat, or assign a worker to start implementing.</div>
              </div>
              <button className="btn sm">Refine</button>
              <button className="btn primary sm" onClick={() => setShowAssign(true)}>
                Assign worker<I.arrowR />
              </button>
            </div>
          )}
        </div>
      </div>
      {planAgentId && (
        <ChatPanel
          messages={messages}
          agent={planAgentId}
          placeholder={isStreaming ? "Steer the planning…" : "Ask the planner to refine the plan…"}
        />
      )}
      {showAssign && (
        <AssignWorkerModal
          taskId={task.id}
          projectId={projectId}
          initialRuntime={task.runtime ?? null}
          onClose={() => setShowAssign(false)}
        />
      )}
    </div>
  );
}

function DiffFileView({ file }: { file: DiffFile }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="diff-file">
      <div className="diff-head" onClick={() => setCollapsed((c) => !c)} style={{ cursor: "pointer" }}>
        <span style={{ color: "var(--text-faint)" }}>{collapsed ? <I.chevR /> : <I.chevD />}</span>
        <span style={{ color: "var(--text)" }}>{file.path}</span>
        <span className="stat">
          <span className="add">+{file.add}</span>
          <span className="del">−{file.del}</span>
        </span>
      </div>
      {!collapsed && (
        <div className="diff-body">
          {file.hunks.map((h, i) => {
            if (h.type === "hunk") {
              return (
                <div key={i} className="diff-row hunk">
                  <span />
                  <span />
                  <span className="code" style={{ paddingLeft: 8 }}>{h.text}</span>
                </div>
              );
            }
            const cls = h.type === "add" ? "add" : h.type === "del" ? "del" : "";
            const marker = h.type === "add" ? "+" : h.type === "del" ? "−" : " ";
            return (
              <div key={i} className={`diff-row ${cls}`}>
                <span className="num">{h.oldNum}</span>
                <span className="num">{h.newNum}</span>
                <span className="code">
                  <span className="marker">{marker} </span>
                  {h.text}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PRView({
  task,
  files,
  messages,
  sidebarLayout,
}: {
  task: Task;
  files: DiffFile[];
  messages: PlanMessage[];
  sidebarLayout: "default" | "compact";
}) {
  const totalAdd = files.reduce((s, f) => s + f.add, 0);
  const totalDel = files.reduce((s, f) => s + f.del, 0);
  const teammates = useTeammates();
  const agentName = task.agent ? teammates.find((a) => a.id === task.agent)?.name : null;

  return (
    <div className={`pr-layout ${sidebarLayout === "compact" ? "compact-side" : ""}`} data-screen-label="Task — PR">
      <div className="pr-diff">
        <div className="pr-summary">
          <div className="pr-summary-head">
            <span className="pr-badge">
              <span style={{ width: 6, height: 6, borderRadius: 50, background: "var(--accent)" }} />
              {task.state === "merged" ? "Merged" : task.state === "prOpen" ? "Open · ready to review" : "Draft"}
            </span>
            <span className="muted" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>#{task.id.replace("AGT-", "")}</span>
            <div style={{ flex: 1 }} />
            <button className="btn sm"><I.github />View on GitHub</button>
          </div>
          <div className="pr-title">{task.title}</div>
          <div className="pr-summary-meta">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {task.agent && <Avatar who={task.agent} size="sm" showStatus />}
              opened by {agentName ?? "—"}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <I.branch />
              {task.branch} → main
            </span>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--diff-add-line)" }}>+{totalAdd}</span>{" "}
              <span style={{ color: "var(--diff-del-line)" }}>−{totalDel}</span>{" "}
              <span className="muted">across {files.length} files</span>
            </span>
          </div>
          <div className="pr-checks">
            <div className="pr-check pass"><span className="check-ico"><I.approved /></span>cargo test — 142 passed</div>
            <div className="pr-check pass"><span className="check-ico"><I.approved /></span>cargo clippy — no warnings</div>
            <div className="pr-check run"><span className="check-ico"><I.spinner /></span>integration / postgres — running (2:14)</div>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--line)" }}>
            <button className="btn sm">Request changes</button>
            <button className="btn sm">Comment</button>
            <div style={{ flex: 1 }} />
            <button className="btn primary sm"><I.approved />Approve & merge</button>
          </div>
        </div>

        {files.map((f, i) => (
          <DiffFileView key={i} file={f} />
        ))}
      </div>
      <ChatPanel
        messages={messages}
        agent={task.agent || "a2"}
        placeholder="Comment, or ask the agent to make changes…"
        sideTabs={["Chat", "Activity", "Checks"]}
      />
    </div>
  );
}

export function TaskDetail({
  task,
  projectId,
  plan,
  planMessages,
  prFiles,
  prMessages,
  conversation,
  jobs,
  memory,
  backHref,
  sidebarLayout = "default",
}: {
  task: Task;
  projectId: string;
  plan: TaskPlan | null;
  planMessages: PlanMessage[];
  prFiles: DiffFile[];
  prMessages: PlanMessage[];
  conversation: TaskConversationMessage[];
  jobs: TaskJob[];
  memory: TaskMemory | null;
  backHref: string;
  sidebarLayout?: "default" | "compact";
}) {
  const hasPr =
    task.state === "inProgress" || task.state === "prOpen" || task.state === "merged";
  const initialMode: Mode = hasPr ? "pr" : "plan";
  const [mode, setMode] = useState<Mode>(initialMode);
  const defaultChatChannel: ChatChannel = hasPr ? "implementation" : "plan";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minHeight: 0 }}>
      <TaskHeader task={task} mode={mode} setMode={setMode} backHref={backHref} hasPr={hasPr} />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {mode === "plan" && (
          <PlanView
            task={task}
            projectId={projectId}
            plan={plan}
            messages={planMessages}
            sidebarLayout={sidebarLayout}
          />
        )}
        {mode === "pr" && (
          <PRView task={task} files={prFiles} messages={prMessages} sidebarLayout={sidebarLayout} />
        )}
        {mode === "chat" && (
          <ChatTab
            task={task}
            projectId={projectId}
            initialMessages={conversation}
            defaultChannel={defaultChatChannel}
          />
        )}
        {mode === "jobs" && (
          <JobsTab task={task} projectId={projectId} jobs={jobs} />
        )}
        {mode === "memory" && (
          <MemoryTab task={task} projectId={projectId} memory={memory} />
        )}
        {mode === "thread" && (
          <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-muted)" }}>
            <div style={{ textAlign: "center", maxWidth: 320 }}>
              <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 22, marginBottom: 8 }}>Thread</div>
              <div style={{ fontSize: 13.5 }}>The full conversation between you, your teammates, and the agents working on this task.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
