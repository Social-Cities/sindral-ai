"use client";

import { Avatar } from "./atoms";
import { I } from "./icons";
import { TEAMMATES, type Project } from "@/lib/data";

export type SidebarView = "project" | "inbox" | "myissues" | "activity";

export function Sidebar({
  view,
  setView,
  project,
  setProject,
  projects,
  agentMetaphor = "teammates",
  onImport,
}: {
  view: SidebarView;
  setView: (v: SidebarView) => void;
  project: string;
  setProject: (p: string) => void;
  projects: Project[];
  agentMetaphor?: "teammates" | "workers" | "processes";
  onImport: () => void;
}) {
  const metaphorLabel =
    { teammates: "Teammates", workers: "Workers", processes: "Processes" }[agentMetaphor] || "Teammates";

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-mark">a</div>
        <span>Agatha</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>v0.4</span>
      </div>

      <div className="sb-section">
        <div className={`sb-item ${view === "inbox" ? "active" : ""}`} onClick={() => setView("inbox")}>
          <span className="sb-ico"><I.inbox /></span>Inbox
          <span className="sb-count">3</span>
        </div>
        <div className={`sb-item ${view === "myissues" ? "active" : ""}`} onClick={() => setView("myissues")}>
          <span className="sb-ico"><I.myIssues /></span>My tasks
          <span className="sb-count">7</span>
        </div>
        <div className={`sb-item ${view === "activity" ? "active" : ""}`} onClick={() => setView("activity")}>
          <span className="sb-ico"><I.activity /></span>Activity
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-section-label">
          <span>Projects</span>
          <span
            className="sb-add"
            title="Import from GitHub"
            onClick={(e) => {
              e.stopPropagation();
              onImport();
            }}
          >
            <I.plus />
          </span>
        </div>
        {projects.map((p) => (
          <div
            key={p.id}
            className={`sb-item sb-project ${project === p.id && view === "project" ? "active" : ""}`}
            onClick={() => {
              setProject(p.id);
              setView("project");
            }}
            title={`${p.repo} (main)`}
          >
            <span className="sb-ico" style={{ fontSize: 13 }}>{p.emoji}</span>
            <span className="sb-project-name">
              <span className="sb-project-title">{p.name}</span>
              <span className="sb-project-repo">
                <I.github />
                {p.repo}
              </span>
            </span>
            {p.planning + p.inProgress > 0 && (
              <span className="sb-count" style={{ color: "var(--accent)" }}>
                ● {p.planning + p.inProgress}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="sb-section">
        <div className="sb-section-label">
          <span>{metaphorLabel}</span>
          <span className="sb-add" title="Configure"><I.settings /></span>
        </div>
        {TEAMMATES.map((a) => (
          <div key={a.id} className="sb-teammate">
            <Avatar who={a.id} showStatus />
            <span className="tm-name">{a.name}</span>
            <span className="tm-status">{a.status === "working" ? a.task : a.status === "online" ? "idle" : "—"}</span>
          </div>
        ))}
      </div>

      <div className="sb-spacer" />

      <div className="sb-section" style={{ marginTop: 0 }}>
        <div className="sb-item">
          <span className="sb-ico"><I.settings /></span>Settings
        </div>
      </div>
    </aside>
  );
}
