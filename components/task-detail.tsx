"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Avatar, Markdown, StatusPill, TypePill, renderInline } from "./atoms";
import { I } from "./icons";
import { useTeammate, useTeammates, usePerson } from "./providers/people-context";
import type { DiffFile, PlanMessage, Task, TaskPlan } from "@/lib/data";

type Mode = "plan" | "pr" | "thread";

function TaskHeader({
  task,
  mode,
  setMode,
  backHref,
}: {
  task: Task;
  mode: Mode;
  setMode: (m: Mode) => void;
  backHref: string;
}) {
  const tabs: { id: Mode; label: string; show: boolean }[] = [
    { id: "plan", label: "Plan", show: true },
    { id: "pr", label: "PR", show: task.state === "inProgress" || task.state === "prOpen" || task.state === "merged" },
    { id: "thread", label: "Thread", show: true },
  ];
  return (
    <div style={{ borderBottom: "1px solid var(--line)", padding: "14px 22px 0", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Link className="btn ghost sm" href={backHref}>← Back</Link>
        <span className="task-id" style={{ fontSize: 12 }}>{task.id}</span>
        <TypePill type={task.type} />
        <StatusPill state={task.state} />
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

function PlanView({
  task,
  plan,
  messages,
  sidebarLayout,
}: {
  task: Task;
  plan: TaskPlan | null;
  messages: PlanMessage[];
  sidebarLayout: "default" | "compact";
}) {
  const isStreaming = task.state === "planning";
  const fullText = plan?.markdown ?? "";
  const partialLen = plan?.streamingPartial?.length ?? 0;
  const [streamPos, setStreamPos] = useState(isStreaming ? partialLen : fullText.length);
  const [paused, setPaused] = useState(false);
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
              <span className="faint">·</span>
              <span className="muted">12 file refs</span>
              {isStreaming && !done && (
                <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setPaused((p) => !p)}>
                  {paused ? "Resume" : <><I.pause />Pause</>}
                </button>
              )}
              {(!isStreaming || done) && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className="btn sm"><I.edit />Edit</button>
                  <button className="btn primary sm">Assign worker<I.arrowR /></button>
                </div>
              )}
            </div>
          </div>
          <Markdown text={visibleText} streaming={isStreaming && !done && !paused} />

          {isStreaming && !done && streamPos > 200 && streamPos < fullText.length - 200 && (
            <div className="thinking">
              <div className="thinking-head">{planAgent?.name ?? "Planner"} is thinking</div>
              <div>
                The rate-limit middleware releases tokens on response start, but for streams the token shouldn&apos;t release until the connection actually closes. Need to flag this in the plan…
              </div>
            </div>
          )}

          {(!isStreaming || done) && (
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
              <button className="btn primary sm">Assign worker<I.arrowR /></button>
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
  plan,
  planMessages,
  prFiles,
  prMessages,
  backHref,
  sidebarLayout = "default",
}: {
  task: Task;
  plan: TaskPlan | null;
  planMessages: PlanMessage[];
  prFiles: DiffFile[];
  prMessages: PlanMessage[];
  backHref: string;
  sidebarLayout?: "default" | "compact";
}) {
  const initialMode: Mode =
    task.state === "inProgress" || task.state === "prOpen" || task.state === "merged" ? "pr" : "plan";
  const [mode, setMode] = useState<Mode>(initialMode);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minHeight: 0 }}>
      <TaskHeader task={task} mode={mode} setMode={setMode} backHref={backHref} />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {mode === "plan" && (
          <PlanView task={task} plan={plan} messages={planMessages} sidebarLayout={sidebarLayout} />
        )}
        {mode === "pr" && (
          <PRView task={task} files={prFiles} messages={prMessages} sidebarLayout={sidebarLayout} />
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
