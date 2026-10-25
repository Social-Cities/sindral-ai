import type { TaskState, WorkflowStep } from '@sindral/shared';
import { getStateStyle } from '@sindral/shared';

interface StatusBadgeProps {
  state: TaskState;
  /** The workflow step the task sits on; used to style custom states. */
  step?: Pick<WorkflowStep, 'type' | 'label'> | null;
  size?: 'sm' | 'md';
}

export function StatusBadge({ state, step, size = 'sm' }: StatusBadgeProps) {
  const config = getStateStyle(state, step);
  // Bright state colors need a darker text variant on light surfaces.
  const color = `light-dark(color-mix(in srgb, ${config.color}, black 55%), ${config.color})`;
  return (
    <span
      data-testid="status-badge"
      data-state={state}
      className={`inline-flex items-center gap-1.5 rounded font-mono font-medium shrink-0 whitespace-nowrap ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
      }`}
      style={{ color, backgroundColor: config.bg }}
    >
      <span
        data-testid="status-dot"
        aria-hidden="true"
        className={`rounded-full shrink-0 ${config.pulsing ? 'animate-pulse' : ''} ${size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2'}`}
        style={{ backgroundColor: config.color }}
      />
      {config.label}
    </span>
  );
}
