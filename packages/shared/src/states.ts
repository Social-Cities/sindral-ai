import type { TaskState, WorkflowStep } from './types.js';

export interface StateStyle {
  label: string;
  color: string;
  bg: string;
  pulsing: boolean;
}

/** Visual configuration for well-known states (mirrors the Figma design system). */
export const STATE_CONFIG: Record<string, StateStyle> = {
  todo: { label: 'Todo', color: '#8b92a8', bg: 'rgba(139,146,168,0.08)', pulsing: false },
  planning: { label: 'Planning', color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', pulsing: true },
  'plan-review': { label: 'Plan Review', color: '#38bdf8', bg: 'rgba(56,189,248,0.08)', pulsing: false },
  'planning-feedback': { label: 'Plan Feedback', color: '#fb923c', bg: 'rgba(251,146,60,0.08)', pulsing: true },
  implement: { label: 'Implementing', color: '#a78bfa', bg: 'rgba(167,139,250,0.08)', pulsing: true },
  'adversarial-review': { label: 'Adversarial Review', color: '#f472b6', bg: 'rgba(244,114,182,0.08)', pulsing: true },
  verify: { label: 'Verifying', color: '#2dd4bf', bg: 'rgba(45,212,191,0.08)', pulsing: true },
  'in-review': { label: 'In Review', color: '#22d3ee', bg: 'rgba(34,211,238,0.08)', pulsing: false },
  'implement-feedback': { label: 'Impl. Feedback', color: '#c084fc', bg: 'rgba(192,132,252,0.08)', pulsing: true },
  'conflict-resolution': { label: 'Resolving Conflict', color: '#fb923c', bg: 'rgba(251,146,60,0.08)', pulsing: true },
  merge: { label: 'Merging', color: '#34d399', bg: 'rgba(52,211,153,0.08)', pulsing: true },
  done: { label: 'Done', color: '#34d399', bg: 'rgba(52,211,153,0.08)', pulsing: false },
  'wont-do': { label: "Won't do", color: '#8b92a8', bg: 'rgba(139,146,168,0.08)', pulsing: false },
  failure: { label: 'Failed', color: '#f87171', bg: 'rgba(248,113,113,0.08)', pulsing: false },
  troubleshoot: { label: 'Troubleshoot', color: '#fb923c', bg: 'rgba(251,146,60,0.08)', pulsing: true },
};

const AGENT_FALLBACK: StateStyle = { label: '', color: '#a78bfa', bg: 'rgba(167,139,250,0.08)', pulsing: true };
const HUMAN_FALLBACK: StateStyle = { label: '', color: '#38bdf8', bg: 'rgba(56,189,248,0.08)', pulsing: false };

function humanize(state: string): string {
  return state
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Resolve a style for any state, including custom ones from user-defined workflows. */
export function getStateStyle(state: TaskState, step?: Pick<WorkflowStep, 'type' | 'label'> | null): StateStyle {
  const known = STATE_CONFIG[state];
  if (known) return known;
  const base = step?.type === 'agent' ? AGENT_FALLBACK : HUMAN_FALLBACK;
  return { ...base, label: step?.label ?? humanize(state) };
}

/** States where the task is waiting for the user, i.e. no agent is running. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'wont-do']);

/** States where no workflow step drives the task and the user must intervene. */
export const OFF_PATH_STATES: ReadonlySet<string> = new Set(['failure', 'troubleshoot', 'conflict-resolution']);

export function isOffPath(state: TaskState): boolean {
  return OFF_PATH_STATES.has(state);
}

/** Grouping used by the dashboard stat cards. */
export function dashboardBucket(state: TaskState, step?: Pick<WorkflowStep, 'type'> | null): 'todo' | 'in-progress' | 'in-review' | 'done' | 'failed' {
  if (state === 'todo') return 'todo';
  if (TERMINAL_STATES.has(state)) return 'done';
  if (state === 'failure') return 'failed';
  if (state === 'in-review') return 'in-review';
  if (step?.type === 'human' && state !== 'plan-review') return 'in-review';
  return 'in-progress';
}
