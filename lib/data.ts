// UI mappings only. Live data is fetched from Supabase via lib/queries/*.
// Types are re-exported here so existing imports keep working.

export type {
  AgentRole,
  AgentStatus,
  Teammate,
  PersonaPresetId,
  Human,
  Project,
  ProjectWithCounts,
  Task,
  TaskType,
  TaskState,
  TaskPriority,
  PlanMessage,
  DiffRow,
  DiffRowType,
  DiffFile,
  ActivityItem,
  TaskPlan,
  RuntimeKind,
  JobType,
  TaskJob,
  TaskJobEvent,
  TaskJobStatus,
  TaskConversationMessage,
  ChatChannel,
  ChatFromKind,
  TaskMemory,
} from "./db/types";

import type { RuntimeKind } from "./db/types";

export const RUNTIME_KINDS: Record<RuntimeKind, { label: string; description: string }> = {
  claude_code: {
    label: "Claude Code",
    description:
      "Anthropic's coding agent. Best for code edits across many files and long-context reasoning.",
  },
  codex: {
    label: "Codex",
    description:
      "OpenAI's CLI coding agent. Best for short, targeted edits and shell-driven work.",
  },
};

// Supported models per agent runtime. The first entry is the default when an
// agent is selected with no prior model picked.
export const MODELS_BY_RUNTIME: Record<RuntimeKind, readonly string[]> = {
  claude_code: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  codex: [
    "gpt-5-codex",
    "gpt-5",
    "o4-mini",
  ],
};

export function inferRuntimeFromModel(model: string): RuntimeKind {
  for (const runtime of Object.keys(MODELS_BY_RUNTIME) as RuntimeKind[]) {
    if (MODELS_BY_RUNTIME[runtime].includes(model)) return runtime;
  }
  // Heuristic fallback for unknown / legacy values.
  return model.toLowerCase().startsWith("claude") ? "claude_code" : "codex";
}

import type { TaskType, TaskState } from "./db/types";

export const TASK_TYPES: Record<TaskType, { label: string; color: string }> = {
  feature: { label: "Feature", color: "var(--type-feature)" },
  bug: { label: "Bug", color: "var(--type-bug)" },
  chore: { label: "Chore", color: "var(--type-chore)" },
  refactor: { label: "Refactor", color: "var(--type-refactor)" },
  spike: { label: "Spike", color: "var(--type-spike)" },
  docs: { label: "Docs", color: "var(--type-docs)" },
};

export const TASK_STATES: Record<
  TaskState,
  { label: string; color: string; order: number }
> = {
  backlog: { label: "Backlog", color: "var(--status-backlog)", order: 0 },
  planning: { label: "Planning", color: "var(--status-planning)", order: 1 },
  planReady: { label: "Plan ready", color: "var(--status-plan-ready)", order: 2 },
  inProgress: { label: "In progress", color: "var(--status-in-progress)", order: 3 },
  prOpen: { label: "PR open", color: "var(--status-pr-open)", order: 4 },
  merged: { label: "Merged", color: "var(--status-merged)", order: 5 },
  blocked: { label: "Blocked", color: "var(--status-blocked)", order: 6 },
};
