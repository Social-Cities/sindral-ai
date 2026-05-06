"use client";

import { useState } from "react";
import { Avatar } from "./atoms";
import { I } from "./icons";
import { PROJECTS, TASK_TYPES, TEAMMATES, type TaskType } from "@/lib/data";

export interface NewTaskPayload {
  type: TaskType;
  title: string;
  desc: string;
  autoplan: boolean;
  planner: string;
}

export function NewTaskModal({ onClose, onCreate }: { onClose: () => void; onCreate: (p: NewTaskPayload) => void }) {
  const [type, setType] = useState<TaskType>("feature");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [autoplan, setAutoplan] = useState(true);
  const [planner, setPlanner] = useState("a1");
  const proj = PROJECTS[0];

  const submit = () => {
    if (!title.trim()) return;
    onCreate({ type, title, desc, autoplan, planner });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>New task</span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            <span style={{ fontSize: 13 }}>{proj.emoji}</span>
            <span>{proj.name}</span>
            <span className="faint">·</span>
            <I.github />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{proj.repo}</span>
          </span>
        </div>
        <div className="modal-body">
          <div className="field">
            <input
              className="field-input title"
              autoFocus
              placeholder="Task title…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <textarea
              className="field-input"
              placeholder="Add description, context, links…"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={4}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <span className="field-label">Type</span>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {Object.entries(TASK_TYPES).map(([k, v]) => (
                  <button
                    key={k}
                    onClick={() => setType(k as TaskType)}
                    className="filter-chip"
                    style={
                      type === k
                        ? { background: "var(--accent-soft)", color: "var(--accent)", borderColor: "var(--accent)", borderStyle: "solid" }
                        : {}
                    }
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 1.5, background: v.color, display: "inline-block" }} />
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 12, marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={autoplan} onChange={(e) => setAutoplan(e.target.checked)} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 13.5 }}>
                  <I.sparkle /> Auto-plan with an agent
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  Skip the backlog and have a planner draft an implementation plan immediately.
                </div>
              </div>
            </label>
            {autoplan && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
                <span className="muted" style={{ fontSize: 12.5 }}>Planner:</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {TEAMMATES.filter((a) => a.role === "planner").map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setPlanner(a.id)}
                      className="btn sm"
                      style={
                        planner === a.id
                          ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                          : {}
                      }
                    >
                      <Avatar who={a.id} size="sm" />
                      {a.name}
                      <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{a.model}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel<span className="kbd">Esc</span>
          </button>
          <button className="btn primary" onClick={submit} disabled={!title.trim()}>
            {autoplan ? "Create & plan" : "Create"}
            <span className="kbd">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function ImportModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState("");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540 }}>
        <div className="modal-head">
          <I.github /> Import from GitHub
        </div>
        <div className="modal-body">
          {step === 0 && (
            <>
              <div className="field">
                <span className="field-label">Repository URL or owner/repo</span>
                <input
                  className="field-input"
                  placeholder="github.com/agatha/kettle"
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Agatha will clone the repo, index the codebase, and set up worker sandboxes. Read-only by default — you&apos;ll grant write access per task.
              </div>
            </>
          )}
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "10px 0" }}>
              {["Cloning repository", "Indexing files (4,231 files)", "Detecting build system", "Setting up sandbox image"].map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {i < 2 ? (
                    <span style={{ color: "#4a8a5a" }}><I.check /></span>
                  ) : i === 2 ? (
                    <span style={{ color: "var(--accent)" }}><I.spinner /></span>
                  ) : (
                    <span style={{ color: "var(--text-faint)" }}>○</span>
                  )}
                  <span style={{ fontSize: 13.5, color: i > 2 ? "var(--text-muted)" : "var(--text)" }}>{s}</span>
                  {i < 2 && (
                    <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginLeft: "auto" }}>1.4s</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {step === 0 && (
            <button className="btn primary" disabled={!url} onClick={() => setStep(1)}>
              Connect
            </button>
          )}
          {step === 1 && (
            <button className="btn primary" disabled>
              Setting up…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
