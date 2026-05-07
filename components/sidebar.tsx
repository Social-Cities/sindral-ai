"use client";

import Link from "next/link";
import { useTransition } from "react";
import { Avatar } from "./atoms";
import { I } from "./icons";
import { useTeammates } from "./providers/people-context";
import { signOutAction } from "@/lib/actions/auth";
import type { ProjectWithCounts } from "@/lib/data";

export type SidebarView = "project" | "inbox" | "myissues" | "activity";

export function Sidebar({
  view,
  projectId,
  projects,
  currentUserEmail,
  agentMetaphor = "teammates",
  onNewProject,
  onManageTeammates,
}: {
  view: SidebarView;
  projectId: string | null;
  projects: ProjectWithCounts[];
  currentUserEmail: string | null;
  agentMetaphor?: "teammates" | "workers" | "processes";
  onNewProject: () => void;
  onManageTeammates: () => void;
}) {
  const teammates = useTeammates();
  const [signingOut, startSignOut] = useTransition();
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
        <Link href="/inbox" className={`sb-item ${view === "inbox" ? "active" : ""}`}>
          <span className="sb-ico"><I.inbox /></span>Inbox
          <span className="sb-count">3</span>
        </Link>
        <Link href="/my-tasks" className={`sb-item ${view === "myissues" ? "active" : ""}`}>
          <span className="sb-ico"><I.myIssues /></span>My tasks
          <span className="sb-count">7</span>
        </Link>
        <Link href="/activity" className={`sb-item ${view === "activity" ? "active" : ""}`}>
          <span className="sb-ico"><I.activity /></span>Activity
        </Link>
      </div>

      <div className="sb-section">
        <div className="sb-section-label">
          <span>Projects</span>
          <span
            className="sb-add"
            title="New project"
            onClick={(e) => {
              e.stopPropagation();
              onNewProject();
            }}
          >
            <I.plus />
          </span>
        </div>
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className={`sb-item sb-project ${projectId === p.id && view === "project" ? "active" : ""}`}
            title={p.repo ? `${p.repo} (main)` : `${p.name} (no repo)`}
          >
            <span className="sb-ico" style={{ fontSize: 13 }}>{p.emoji}</span>
            <span className="sb-project-name">
              <span className="sb-project-title">{p.name}</span>
              <span className="sb-project-repo">
                <I.github />
                {p.repo ?? "No repo"}
              </span>
            </span>
            {p.planning + p.inProgress > 0 && (
              <span className="sb-count" style={{ color: "var(--accent)" }}>
                ● {p.planning + p.inProgress}
              </span>
            )}
          </Link>
        ))}
      </div>

      <div className="sb-section">
        <div className="sb-section-label">
          <span>{metaphorLabel}</span>
          <span
            className="sb-add"
            title="Manage teammates"
            onClick={(e) => {
              e.stopPropagation();
              onManageTeammates();
            }}
          >
            <I.settings />
          </span>
        </div>
        {teammates.map((a) => (
          <div key={a.id} className="sb-teammate">
            <Avatar who={a.id} showStatus />
            <span className="tm-name">{a.name}</span>
            <span className="tm-status">
              {a.status === "working" ? a.task : a.status === "online" ? "idle" : "—"}
              {a.queue.length > 0 && (
                <span
                  className="muted"
                  style={{ fontSize: 10.5, marginLeft: 6 }}
                  title={`${a.queue.length} queued: ${a.queue.join(", ")}`}
                >
                  +{a.queue.length}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="sb-spacer" />

      <div className="sb-section" style={{ marginTop: 0 }}>
        {currentUserEmail && (
          <div
            className="sb-item"
            style={{ cursor: "default", color: "var(--text-muted)", fontSize: 12 }}
            title={currentUserEmail}
          >
            <span className="sb-ico"><I.settings /></span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentUserEmail}
            </span>
          </div>
        )}
        <button
          type="button"
          className="sb-item"
          onClick={() => startSignOut(() => signOutAction())}
          disabled={signingOut}
          style={{
            background: "none",
            border: "none",
            font: "inherit",
            color: "inherit",
            textAlign: "left",
            cursor: signingOut ? "wait" : "pointer",
            width: "100%",
          }}
        >
          <span className="sb-ico"><I.settings /></span>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </aside>
  );
}
