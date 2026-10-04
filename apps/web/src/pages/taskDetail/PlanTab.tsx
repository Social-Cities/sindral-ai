import { useState } from 'react';
import type { TaskWithRelations } from '@sindral/shared';
import { Button } from '@/components/Button';
import { Markdown } from '@/components/Markdown';
import { planOverview, type PlanOverview } from '@/lib/plan';

interface PlanTabProps {
  task: TaskWithRelations;
  canApprove: boolean;
  approving: boolean;
  onApprove: () => void;
}

const PLAN_SUMMARY_FIELDS: { key: keyof PlanOverview; label: string }[] = [
  { key: 'behaviorChange', label: 'What behavior is changing' },
  { key: 'affectedSystems', label: 'What files/systems are affected' },
  { key: 'invariants', label: 'Important invariants' },
  { key: 'edgeCases', label: 'Edge cases' },
  { key: 'verification', label: 'How correctness will be verified' },
];

export function PlanTab({ task, canApprove, approving, onApprove }: PlanTabProps) {
  const [view, setView] = useState<'summary' | 'implementation'>('summary');
  const overview = task.plan ? planOverview(task.plan) : null;

  return (
    <div className="overflow-y-auto h-full p-6">
      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plan</p>
            <p className="text-xs text-muted-foreground mt-1">
              Review the summary first, or open the full implementation plan sent to the agent.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {task.plan && (
              <div className="inline-flex rounded-md border border-border bg-secondary p-0.5" role="tablist" aria-label="Plan view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'summary'}
                  onClick={() => setView('summary')}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === 'summary' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-secondary-foreground'}`}
                >
                  Summary
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'implementation'}
                  onClick={() => setView('implementation')}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === 'implementation' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-secondary-foreground'}`}
                >
                  Implementation plan
                </button>
              </div>
            )}
            {canApprove && (
              <Button variant="success" onClick={onApprove} disabled={approving}>
                Approve Plan
              </Button>
            )}
          </div>
        </div>

        {task.plan && overview && view === 'summary' ? (
          <div className="grid gap-3">
            {PLAN_SUMMARY_FIELDS.map((field) => (
              <div key={field.key} className="p-4 rounded-lg bg-muted border border-border min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{field.label}</p>
                <div className="overflow-x-auto">
                  <Markdown className="text-xs [&_table]:min-w-full">{overview[field.key]}</Markdown>
                </div>
              </div>
            ))}
          </div>
        ) : task.plan ? (
          <div className="p-5 rounded-lg bg-muted border border-border">
            <Markdown>{task.plan}</Markdown>
          </div>
        ) : (
          <div className="p-5 rounded-lg bg-secondary border border-border">
            <p className="text-sm text-muted-foreground">No plan is available yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
