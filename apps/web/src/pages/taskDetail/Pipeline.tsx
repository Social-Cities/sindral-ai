import { useMemo } from 'react';
import type { TaskWithRelations, Workflow } from '@sindral/shared';
import { TERMINAL_STATES, getStateStyle, getStep, happyPath, isOffPath } from '@sindral/shared';

interface PipelineProps {
  task: TaskWithRelations;
  workflow: Workflow | null;
}

/** Horizontal stepper of the workflow's happy path with the current step highlighted. */
export function Pipeline({ task, workflow }: PipelineProps) {
  const path = useMemo(() => (workflow ? happyPath(workflow) : []), [workflow]);
  const offPath = isOffPath(task.state);
  const current = workflow ? getStep(workflow, task.currentStepId ?? workflow.entryStepId) : null;

  // Off-happy-path steps (feedback loops) count as "on" the step they return to.
  let currentIdx = current ? path.findIndex((s) => s.id === current.id) : -1;
  if (currentIdx === -1 && current && workflow) {
    const returnEdge = workflow.edges.find((e) => e.from === current.id && e.event === 'complete');
    if (returnEdge) currentIdx = path.findIndex((s) => s.id === returnEdge.to);
  }
  if (task.state === 'done') currentIdx = path.length - 1;

  if (offPath) {
    const style = getStateStyle(task.state);
    const failedStep = workflow ? getStep(workflow, task.failedStepId ?? task.currentStepId) : null;
    const offPathLabel = task.state === 'failure' ? '⚠ Failed' : task.state === 'conflict-resolution' ? '◐ Resolving Conflict' : '◐ Troubleshoot';
    return (
      <div className="flex items-center gap-2 mt-4" data-testid="pipeline-offpath">
        <span className="text-xs px-2 py-1 rounded font-mono font-medium" style={{ background: '#f8711815', color: style.color, border: '1px solid #fb923c20' }}>
          {offPathLabel}
        </span>
        <span className="text-xs text-muted-foreground">
          — task is off the main flow{failedStep ? ` (failed at ${failedStep.label})` : ''}
        </span>
      </div>
    );
  }

  if (path.length === 0) {
    return <p className="text-xs text-muted-foreground mt-4">No workflow attached.</p>;
  }

  return (
    <ol className="flex items-center gap-0 mt-4 overflow-x-auto pb-1" aria-label="Pipeline" tabIndex={0}>
      {path.map((step, i) => {
        const isCurrent = i === currentIdx && !TERMINAL_STATES.has(task.state);
        const isPast = i < currentIdx || (task.state === 'done' && i <= currentIdx);
        return (
          <li key={step.id} className="flex items-center shrink-0" aria-current={isCurrent ? 'step' : undefined}>
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium"
              style={{
                background: isCurrent ? '#7c3aed15' : isPast ? '#0d0d1c' : 'transparent',
                border: isCurrent ? '1px solid #7c3aed40' : isPast ? '1px solid #1c1c30' : '1px solid transparent',
                color: isCurrent ? '#a78bfa' : isPast ? '#8b92a8' : '#7b849a',
              }}
            >
              {isPast && (
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
                  <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              )}
              {step.label}
            </div>
            {i < path.length - 1 && <div className="w-4 h-px mx-0.5" style={{ background: isPast ? '#2a2a44' : '#1c1c30' }} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
