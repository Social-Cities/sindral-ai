"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "./atoms";
import { I } from "./icons";
import { useTeammates } from "./providers/people-context";
import {
  MODELS_BY_RUNTIME,
  RUNTIME_KINDS,
  TASK_TYPES,
  inferRuntimeFromModel,
  type AgentRole,
  type PersonaPresetId,
  type Project,
  type RuntimeKind,
  type TaskType,
  type Teammate,
} from "@/lib/data";
import {
  PERSONA_PRESETS,
  getPersonaPreset,
} from "@/lib/personas";
import { createTaskAction } from "@/lib/actions/tasks";
import {
  createProjectAction,
  updateProjectAction,
} from "@/lib/actions/projects";
import {
  createTeammateAction,
  deleteTeammateAction,
  updateTeammateAction,
} from "@/lib/actions/teammates";
import { assignWorkerAction } from "@/lib/actions/workflows";

export interface NewTaskPayload {
  type: TaskType;
  title: string;
  desc: string;
  autoplan: boolean;
  planner: string | null;
  runtime: RuntimeKind;
}

export function NewTaskModal({
  projects,
  defaultProjectId,
  onClose,
}: {
  projects: Project[];
  defaultProjectId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const teammates = useTeammates();
  const planners = teammates.filter((a) => a.role === "planner");
  const [projectId, setProjectId] = useState<string>(
    defaultProjectId ?? projects[0]?.id ?? "",
  );
  const [type, setType] = useState<TaskType>("feature");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [autoplan, setAutoplan] = useState(true);
  const [planner, setPlanner] = useState(planners[0]?.id ?? "");
  const [runtime, setRuntime] = useState<RuntimeKind>("claude_code");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const project = projects.find((p) => p.id === projectId) ?? null;
  const canSubmit =
    !!title.trim() &&
    !!projectId &&
    (!autoplan || planners.length === 0 || !!planner) &&
    !pending;

  const submit = () => {
    if (!canSubmit) return;
    if (autoplan && !planner) {
      setError("Pick a planner or turn off auto-plan.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createTaskAction({
        projectId,
        type,
        title,
        desc,
        autoplan,
        planner: autoplan ? planner : null,
        runtime,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>New task</span>
          {project && (
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              <I.github />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                {project.repo ?? "no repo"}
              </span>
            </span>
          )}
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

          <div className="field">
            <span className="field-label">Project</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProjectId(p.id)}
                  className="btn sm"
                  style={
                    projectId === p.id
                      ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                      : {}
                  }
                >
                  <span style={{ fontSize: 13 }}>{p.emoji}</span>
                  {p.name}
                </button>
              ))}
            </div>
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

          <div className="field">
            <span className="field-label">Runtime</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(Object.keys(RUNTIME_KINDS) as RuntimeKind[]).map((rk) => (
                <button
                  key={rk}
                  type="button"
                  onClick={() => setRuntime(rk)}
                  className="btn sm"
                  style={
                    runtime === rk
                      ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                      : {}
                  }
                  title={RUNTIME_KINDS[rk].description}
                >
                  {RUNTIME_KINDS[rk].label}
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {RUNTIME_KINDS[runtime].description}
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
            {autoplan && planners.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--line)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span className="muted" style={{ fontSize: 12.5 }}>Planner:</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {planners.map((a) => (
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
            {autoplan && planners.length === 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--line)", fontSize: 12.5, color: "var(--type-bug)" }}>
                No teammates with the planner role. Create one in Teammates first, or turn off auto-plan.
              </div>
            )}
          </div>
          {error && (
            <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginTop: 8 }}>{error}</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={pending}>
            Cancel<span className="kbd">Esc</span>
          </button>
          <button className="btn primary" onClick={submit} disabled={!canSubmit}>
            {pending ? "Creating…" : autoplan ? "Create & plan" : "Create"}
            <span className="kbd">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("◆");
  const [repo, setRepo] = useState("");
  const [description, setDescription] = useState("");
  const [step, setStep] = useState<"form" | "confirmRepo">("form");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmedName = name.trim();
  const trimmedRepo = repo.trim();

  const create = () => {
    if (!trimmedName) return;
    setError(null);
    startTransition(async () => {
      const result = await createProjectAction({
        name: trimmedName,
        repo: trimmedRepo === "" ? null : trimmedRepo,
        emoji,
        description: description.trim() ? description.trim() : null,
      });
      if (!result.ok) {
        setError(result.error);
        setStep("form");
        return;
      }
      router.refresh();
      router.push(`/projects/${result.project.id}`);
      onClose();
    });
  };

  const onSubmit = () => {
    if (!trimmedName) return;
    if (trimmedRepo === "") {
      setStep("confirmRepo");
      return;
    }
    create();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540 }}>
        <div className="modal-head">
          {step === "form" ? (
            <>
              <I.plus /> New project
            </>
          ) : (
            <>
              <I.github /> No repo yet?
            </>
          )}
        </div>
        <div className="modal-body">
          {step === "form" && (
            <>
              <div className="field" style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                <input
                  className="field-input"
                  style={{ width: 56, textAlign: "center", fontSize: 18 }}
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
                  aria-label="Emoji"
                />
                <input
                  className="field-input title"
                  autoFocus
                  placeholder="Project name…"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
              <div className="field">
                <span className="field-label">GitHub repo (optional)</span>
                <input
                  className="field-input"
                  placeholder="github.com/sindral/kettle"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                />
                <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                  Leave blank to set up the project without a repo. You can add or
                  change it later from project settings.
                </div>
              </div>
              <div className="field">
                <span className="field-label">Description (optional)</span>
                <textarea
                  className="field-input"
                  placeholder="What is this project about?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </div>
              {error && (
                <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginTop: 8 }}>{error}</div>
              )}
            </>
          )}
          {step === "confirmRepo" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13.5 }}>
                You didn&apos;t link a GitHub repo. Want Sindral to create one for{" "}
                <strong>{trimmedName}</strong>?
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Either way you can connect or change the repo later from project
                settings.
              </div>
              {error && (
                <div style={{ color: "var(--type-bug)", fontSize: 12.5 }}>{error}</div>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {step === "form" && (
            <>
              <button className="btn ghost" onClick={onClose} disabled={pending}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={onSubmit}
                disabled={!trimmedName || pending}
              >
                {pending ? "Creating…" : "Create"}
              </button>
            </>
          )}
          {step === "confirmRepo" && (
            <>
              <button
                className="btn ghost"
                onClick={() => setStep("form")}
                disabled={pending}
              >
                Back
              </button>
              <button className="btn ghost" onClick={create} disabled={pending}>
                {pending ? "Creating…" : "Skip — I'll add it later"}
              </button>
              <button className="btn primary" onClick={create} disabled={pending}>
                {pending ? "Creating…" : "Yes, create one for me"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const ROLES: AgentRole[] = ["planner", "implementer", "reviewer"];

export function TeammatesModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const teammates = useTeammates();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 620 }}
      >
        <div className="modal-head">
          <I.settings /> Teammates
          <button
            className="btn primary sm"
            style={{ marginLeft: "auto" }}
            onClick={() => setEditingId("new")}
          >
            <I.plus /> New
          </button>
        </div>
        <div className="modal-body">
          {teammates.length === 0 && (
            <div className="muted" style={{ fontSize: 13 }}>
              No teammates yet. Create one to start running tasks.
            </div>
          )}
          {teammates.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <Avatar who={a.id} showStatus />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 13.5 }}>
                  {a.name}{" "}
                  <span
                    className="muted"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      marginLeft: 4,
                    }}
                  >
                    {a.role} · {a.model} ·{" "}
                    {getPersonaPreset(a.personaPreset).label}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {a.status === "working" && a.task ? (
                    <>
                      working on <code>{a.task}</code>
                      {a.queue.length > 0 && ` · +${a.queue.length} queued`}
                    </>
                  ) : a.queue.length > 0 ? (
                    `idle · ${a.queue.length} queued`
                  ) : (
                    a.status
                  )}
                </div>
              </div>
              <button
                className="btn ghost sm"
                onClick={() => setEditingId(a.id)}
              >
                Edit
              </button>
              <button
                className="btn ghost sm"
                onClick={async () => {
                  if (!confirm(`Delete ${a.name}?`)) return;
                  setError(null);
                  const r = await deleteTeammateAction(a.id);
                  if (!r.ok) {
                    setError(r.error);
                    return;
                  }
                  router.refresh();
                }}
              >
                Delete
              </button>
            </div>
          ))}
          {error && (
            <div
              style={{
                color: "var(--type-bug)",
                fontSize: 12.5,
                marginTop: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {editingId !== null && (
        <TeammateEditModal
          teammate={
            editingId === "new"
              ? null
              : teammates.find((t) => t.id === editingId) ?? null
          }
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

function TeammateEditModal({
  teammate,
  onClose,
}: {
  teammate: Teammate | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(teammate?.name ?? "");
  const [role, setRole] = useState<AgentRole>(teammate?.role ?? "planner");
  const initialModel =
    teammate?.model ?? MODELS_BY_RUNTIME.claude_code[0];
  const [agent, setAgent] = useState<RuntimeKind>(
    inferRuntimeFromModel(initialModel),
  );
  const [model, setModel] = useState(initialModel);

  const onPickAgent = (next: RuntimeKind) => {
    setAgent(next);
    const models = MODELS_BY_RUNTIME[next];
    if (!models.includes(model)) setModel(models[0]);
  };
  const [hue, setHue] = useState<number>(teammate?.hue ?? 200);
  const [personaPreset, setPersonaPreset] = useState<PersonaPresetId>(
    teammate?.personaPreset ?? "typescript",
  );
  const [personaPrompt, setPersonaPrompt] = useState(
    teammate?.personaPrompt ?? getPersonaPreset("typescript").prompt,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onPickPreset = (id: PersonaPresetId) => {
    setPersonaPreset(id);
    if (id !== "custom") {
      setPersonaPrompt(getPersonaPreset(id).prompt);
    } else if (!personaPrompt.trim()) {
      setPersonaPrompt("");
    }
  };

  const onEditPrompt = (next: string) => {
    setPersonaPrompt(next);
    // If the user edits a preset's text, switch to "custom" so we don't
    // mislabel it.
    if (personaPreset !== "custom") {
      const presetText = getPersonaPreset(personaPreset).prompt;
      if (next !== presetText) setPersonaPreset("custom");
    }
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (personaPreset === "custom" && !personaPrompt.trim()) {
      setError("Custom persona requires a prompt.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = teammate
        ? await updateTeammateAction({
            id: teammate.id,
            name: trimmedName,
            role,
            model: model.trim(),
            hue,
            personaPreset,
            personaPrompt:
              personaPreset === "custom" ? personaPrompt.trim() : undefined,
          })
        : await createTeammateAction({
            name: trimmedName,
            role,
            model: model.trim(),
            hue,
            personaPreset,
            personaPrompt:
              personaPreset === "custom" ? personaPrompt.trim() : undefined,
          });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      onClose();
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480 }}
      >
        <div className="modal-head">
          {teammate ? (
            <>
              <I.edit /> Edit teammate
            </>
          ) : (
            <>
              <I.plus /> New teammate
            </>
          )}
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              autoFocus
              placeholder="e.g. Iris"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <span className="field-label">Role</span>
            <div style={{ display: "flex", gap: 6 }}>
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="btn sm"
                  onClick={() => setRole(r)}
                  style={
                    role === r
                      ? {
                          borderColor: "var(--accent)",
                          background: "var(--accent-soft)",
                          color: "var(--accent)",
                        }
                      : {}
                  }
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Agent</span>
            <select
              className="field-input"
              value={agent}
              onChange={(e) => onPickAgent(e.target.value as RuntimeKind)}
            >
              {(Object.keys(RUNTIME_KINDS) as RuntimeKind[]).map((k) => (
                <option key={k} value={k}>
                  {RUNTIME_KINDS[k].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">Model</span>
            <select
              className="field-input"
              value={
                MODELS_BY_RUNTIME[agent].includes(model)
                  ? model
                  : MODELS_BY_RUNTIME[agent][0]
              }
              onChange={(e) => setModel(e.target.value)}
            >
              {MODELS_BY_RUNTIME[agent].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">Avatar hue ({hue}°)</span>
            <input
              type="range"
              min={0}
              max={359}
              value={hue}
              onChange={(e) => setHue(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div className="field">
            <span className="field-label">Persona</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PERSONA_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn sm"
                  onClick={() => onPickPreset(p.id)}
                  style={
                    personaPreset === p.id
                      ? {
                          borderColor: "var(--accent)",
                          background: "var(--accent-soft)",
                          color: "var(--accent)",
                        }
                      : {}
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <textarea
              className="field-input"
              value={personaPrompt}
              onChange={(e) => onEditPrompt(e.target.value)}
              rows={4}
              placeholder="System prompt the agent runs with…"
              style={{
                resize: "vertical",
                fontFamily: "inherit",
                marginTop: 8,
              }}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Pick a preset or edit the prompt to write your own. Editing a
              preset's text switches it to <strong>Custom</strong>.
            </div>
          </div>
          {error && (
            <div
              style={{
                color: "var(--type-bug)",
                fontSize: 12.5,
                marginTop: 8,
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={!name.trim() || pending}
          >
            {pending ? "Saving…" : teammate ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectSettingsModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [emoji, setEmoji] = useState(project.emoji);
  const [repo, setRepo] = useState(project.repo ?? "");
  const [description, setDescription] = useState(project.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setError(null);
    startTransition(async () => {
      const trimmedRepo = repo.trim();
      const trimmedDesc = description.trim();
      const result = await updateProjectAction({
        id: project.id,
        name: trimmedName,
        repo: trimmedRepo === "" ? null : trimmedRepo,
        emoji,
        description: trimmedDesc === "" ? null : trimmedDesc,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540 }}>
        <div className="modal-head">
          <I.settings /> Project settings
        </div>
        <div className="modal-body">
          <div className="field" style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <input
              className="field-input"
              style={{ width: 56, textAlign: "center", fontSize: 18 }}
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
              aria-label="Emoji"
            />
            <input
              className="field-input title"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <div className="field">
            <span className="field-label">GitHub repo</span>
            <input
              className="field-input"
              placeholder="github.com/sindral/kettle"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              Leave blank to detach the repo. You can reconnect any time.
            </div>
          </div>
          <div className="field">
            <span className="field-label">Description</span>
            <textarea
              className="field-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
          </div>
          {error && (
            <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginTop: 8 }}>{error}</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={!name.trim() || pending}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AssignWorkerModal({
  taskId,
  projectId,
  initialRuntime,
  onClose,
}: {
  taskId: string;
  projectId: string;
  initialRuntime: RuntimeKind | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const teammates = useTeammates();
  const implementers = teammates.filter((t) => t.role === "implementer");
  const [agentId, setAgentId] = useState<string>(implementers[0]?.id ?? "");
  const [runtime, setRuntime] = useState<RuntimeKind>(
    initialRuntime ?? "claude_code",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (!agentId) {
      setError("Pick a teammate to assign.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await assignWorkerAction({
        taskId,
        agentId,
        runtime,
        projectId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="modal-head">
          <I.send /> Assign worker
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">Implementer</span>
            {implementers.length === 0 && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                No teammates with the implementer role. Create one first.
              </div>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {implementers.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAgentId(a.id)}
                  className="btn sm"
                  style={
                    agentId === a.id
                      ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                      : {}
                  }
                >
                  <Avatar who={a.id} size="sm" />
                  {a.name}
                  <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
                    {a.model}
                  </span>
                  {a.status === "working" && (
                    <span className="muted" style={{ fontSize: 10.5 }}>· busy</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Runtime</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(Object.keys(RUNTIME_KINDS) as RuntimeKind[]).map((rk) => (
                <button
                  key={rk}
                  type="button"
                  onClick={() => setRuntime(rk)}
                  className="btn sm"
                  style={
                    runtime === rk
                      ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                      : {}
                  }
                >
                  {RUNTIME_KINDS[rk].label}
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {initialRuntime && initialRuntime !== runtime
                ? `Overrides task default (${RUNTIME_KINDS[initialRuntime].label}).`
                : RUNTIME_KINDS[runtime].description}
            </div>
          </div>
          {error && (
            <div style={{ color: "var(--type-bug)", fontSize: 12.5, marginTop: 8 }}>{error}</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={!agentId || pending}
          >
            {pending ? "Assigning…" : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}
