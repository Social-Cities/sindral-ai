// Domain types — what views and components consume. Snake_case rows from
// Supabase are mapped to camelCase here in `lib/queries/*`.

export type AgentStatus = "working" | "online" | "idle";
export type AgentRole = "planner" | "implementer" | "reviewer";

export type PersonaPresetId =
  | "golang"
  | "typescript"
  | "kotlin"
  | "python"
  | "ruby"
  | "custom";

export interface Teammate {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  hue: number;
  status: AgentStatus;
  /** Task currently held by this agent, or null when idle. */
  task: string | null;
  /** Tasks waiting for this agent to free up, oldest first. */
  queue: string[];
  /** Persona preset id; "custom" when the user wrote their own prompt. */
  personaPreset: PersonaPresetId;
  /** Resolved system prompt used by the worker for this agent. */
  personaPrompt: string;
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
  repo: string | null;
  emoji: string;
  description: string | null;
  active: boolean;
}

export interface ProjectWithCounts extends Project {
  open: number;
  planning: number;
  inProgress: number;
  prOpen: number;
}

export type TaskType =
  | "feature"
  | "bug"
  | "chore"
  | "refactor"
  | "spike"
  | "docs";

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
  projectId: string;
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

export interface TaskPlan {
  markdown: string;
  streamingPartial: string | null;
}
