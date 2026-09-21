import { Link } from 'react-router';
import type { TaskWithRelations, Workflow } from '@sindral/shared';
import { StatusBadge } from '@/components/StatusBadge';
import { RelativeTime } from '@/components/RelativeTime';
import { currentStep } from '@/lib/taskWorkflow';

interface SubtasksTabProps {
  task: TaskWithRelations;
  workflows: Workflow[];
}

export function SubtasksTab({ task, workflows }: SubtasksTabProps) {
  const subtasks = [...task.subtasks].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const done = subtasks.filter((s) => s.state === 'done').length;

  return (
    <div className="overflow-y-auto h-full p-6">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Subtasks</p>
        <p className="text-xs text-muted-foreground mb-4">
          {done}/{subtasks.length} done · each subtask ships as its own PR, stacked on the previous one.
        </p>
        <ol className="space-y-1.5">
          {subtasks.map((sub) => (
            <li key={sub.id}>
              <Link to={`/tasks/${sub.id}`} className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg bg-card border border-border hover:border-border-strong transition-colors">
                <div className="min-w-0 flex items-center gap-3">
                  <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">{sub.sequence ?? '·'}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{sub.title}</p>
                    <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                      {sub.key}
                      {sub.prUrl ? ' · PR open' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <StatusBadge state={sub.state} step={currentStep(sub, workflows)} />
                  <RelativeTime iso={sub.updatedAt} className="text-[10px] font-mono text-muted-foreground" />
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
