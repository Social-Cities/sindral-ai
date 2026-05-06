"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Avatar, StatusPill, TypePill } from "./atoms";
import { I } from "./icons";
import { useCurrentUserId, usePerson } from "./providers/people-context";
import {
  TASK_STATES,
  TASK_TYPES,
  type Project,
  type Task,
} from "@/lib/data";

type Tab = "all" | "mine" | "agents" | "code" | "archive";

export function ProjectView({
  project,
  tasks,
}: {
  project: Project;
  tasks: Task[];
}) {
  const currentUserId = useCurrentUserId();
  const [tab, setTab] = useState<Tab>("all");
  const [filter, setFilter] = useState<{ type: string | null; status: string | null }>({
    type: null,
    status: null,
  });

  let visible = tasks;
  if (tab === "mine") visible = visible.filter((t) => t.assignee === currentUserId);
  if (tab === "agents") visible = visible.filter((t) => t.agent);
  if (filter.type) visible = visible.filter((t) => t.type === filter.type);
  if (filter.status) visible = visible.filter((t) => t.state === filter.status);

  const grouped: Record<string, Task[]> = {};
  Object.keys(TASK_STATES).forEach((k) => (grouped[k] = []));
  visible.forEach((t) => grouped[t.state].push(t));

  const total = tasks.length;
  const planning = tasks.filter((t) => t.state === "planning").length;
  const inProg = tasks.filter((t) => t.state === "inProgress").length;
  const prOpen = tasks.filter((t) => t.state === "prOpen").length;
  const merged = tasks.filter((t) => t.state === "merged").length;
  const mineCount = tasks.filter((t) => t.assignee === currentUserId).length;
  const agentCount = tasks.filter((t) => t.agent).length;

  return (
    <div className="content" data-screen-label={`Project — ${project.name}`}>
      <div className="proj-head">
        <div>
          <div className="page-head" style={{ padding: 0 }}>
            <h1 style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: 28, fontStyle: "normal", fontFamily: "var(--font-sans)", fontWeight: 500, letterSpacing: "-0.02em" }}>{project.emoji}</span>
              {project.name}
            </h1>
            {project.description && <div className="page-sub">{project.description}</div>}
            <div className="repo-bar">
              <a className="repo-chip" href="#" title="Open on GitHub">
                <I.github />
                <span className="repo-chip-name">{project.repo}</span>
                <span className="repo-chip-sep">·</span>
                <I.branch />
                <span className="repo-chip-branch">main</span>
                <span className="repo-chip-sync">
                  <span className="repo-sync-dot" />connected
                </span>
              </a>
              <button className="btn ghost sm">Switch branch</button>
              <button className="btn ghost sm">Settings</button>
            </div>
          </div>
        </div>
        <div className="proj-stats">
          <div className="stat"><div className="stat-num">{total}</div><div className="stat-label">tasks</div></div>
          <div className="stat"><div className="stat-num" style={{ color: "var(--status-planning)" }}>{planning}</div><div className="stat-label">planning</div></div>
          <div className="stat"><div className="stat-num" style={{ color: "var(--status-in-progress)" }}>{inProg}</div><div className="stat-label">in progress</div></div>
          <div className="stat"><div className="stat-num" style={{ color: "var(--status-pr-open)" }}>{prOpen}</div><div className="stat-label">pr open</div></div>
          <div className="stat"><div className="stat-num">{merged}</div><div className="stat-label">merged</div></div>
        </div>
      </div>

      <div className="page-tabs">
        <div className={`page-tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>Tasks<span className="tab-count">{total}</span></div>
        <div className={`page-tab ${tab === "mine" ? "active" : ""}`} onClick={() => setTab("mine")}>Mine<span className="tab-count">{mineCount}</span></div>
        <div className={`page-tab ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>With agents<span className="tab-count">{agentCount}</span></div>
        <Link href={`/projects/${project.id}/code`} className="page-tab">Code</Link>
        <div className={`page-tab ${tab === "archive" ? "active" : ""}`} onClick={() => setTab("archive")}>Archive</div>
      </div>

      <div className="filter-bar">
        <span style={{ color: "var(--text-muted)" }}>Filter:</span>
        {Object.entries(TASK_TYPES).map(([k, v]) => (
          <span
            key={k}
            className={`filter-chip ${filter.type === k ? "active" : ""}`}
            onClick={() => setFilter((f) => ({ ...f, type: f.type === k ? null : k }))}
            style={
              filter.type === k
                ? ({ ["--accent" as string]: v.color, color: v.color } as React.CSSProperties)
                : ({ ["--type-color" as string]: v.color } as React.CSSProperties)
            }
          >
            <span style={{ width: 6, height: 6, borderRadius: 1.5, background: v.color, display: "inline-block" }} />
            {v.label}
          </span>
        ))}
      </div>

      <div className="task-list">
        {Object.entries(grouped).map(([state, items]) => {
          if (items.length === 0) return null;
          const s = TASK_STATES[state as keyof typeof TASK_STATES];
          return (
            <Fragment key={state}>
              <div className="task-group-head">
                <StatusPill state={state as Task["state"]} withLabel={false} />
                <span style={{ color: "var(--text)", fontWeight: 500 }}>{s.label}</span>
                <span className="tgh-count">{items.length}</span>
              </div>
              {items.map((t) => (
                <TaskRow key={t.id} task={t} projectId={project.id} />
              ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function TaskRow({ task, projectId }: { task: Task; projectId: string }) {
  const agent = usePerson(task.agent);
  return (
    <Link className="task-row" href={`/projects/${projectId}/tasks/${task.id}`}>
      <StatusPill state={task.state} withLabel={false} />
      <span className="task-id">{task.id}</span>
      <span className="task-title">
        <TypePill type={task.type} />
        <span style={{ marginLeft: 10 }}>{task.title}</span>
      </span>
      {task.branch && (
        <span className="task-meta" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)" }}>
          <I.branch />
          {task.branch.length > 24 ? task.branch.slice(0, 24) + "…" : task.branch}
        </span>
      )}
      {task.agent && (
        <span title={agent?.name}>
          <Avatar who={task.agent} size="sm" showStatus />
        </span>
      )}
      {task.assignee && <Avatar who={task.assignee} size="sm" />}
      <span className="task-meta">{task.updated}</span>
    </Link>
  );
}
