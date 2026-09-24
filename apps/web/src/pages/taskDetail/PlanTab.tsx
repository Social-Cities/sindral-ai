import type { TaskWithRelations } from '@sindral/shared';
import { Button } from '@/components/Button';
import { Markdown } from '@/components/Markdown';

interface PlanTabProps {
  task: TaskWithRelations;
  canApprove: boolean;
  approving: boolean;
  onApprove: () => void;
}

export function PlanTab({ task, canApprove, approving, onApprove }: PlanTabProps) {
  return (
    <div className="overflow-y-auto h-full p-6">
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Implementation Plan</p>
            <p className="text-xs text-muted-foreground mt-1">Review the complete plan before implementation begins.</p>
          </div>
          {canApprove && (
            <Button variant="success" onClick={onApprove} disabled={approving}>
              Approve Plan
            </Button>
          )}
        </div>

        {task.plan ? (
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
