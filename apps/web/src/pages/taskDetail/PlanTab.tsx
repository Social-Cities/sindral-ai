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
  onFeedback?: (content: string, target: 'bdd' | 'implementation') => Promise<unknown>;
  sendingFeedback?: boolean;
}

const PLAN_SUMMARY_FIELDS: { key: keyof PlanOverview; label: string }[] = [
  { key: 'behaviorChange', label: 'What behavior is changing' },
  { key: 'affectedSystems', label: 'What files/systems are affected' },
  { key: 'invariants', label: 'Important invariants' },
  { key: 'edgeCases', label: 'Edge cases' },
  { key: 'verification', label: 'How correctness will be verified' },
];

export function PlanTab({ task, canApprove, approving, onApprove, onFeedback, sendingFeedback }: PlanTabProps) {
  const [view, setView] = useState<'summary' | 'implementation' | 'bdd'>('summary');
  const [feedback, setFeedback] = useState('');
  const [target, setTarget] = useState<'bdd' | 'implementation'>('implementation');
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const mobile = Boolean(task.bddPlan || task.pinnedWorkflow?.mobilePlatforms);
  const overview = task.plan ? planOverview(task.plan) : null;

  return (
    <div className="overflow-y-auto h-full p-6">
      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plan</p>
            <p className="text-xs text-muted-foreground mt-1">
              {mobile ? 'Review both the BDD test plan and implementation plan before approving.' : 'Review the summary first, or open the full implementation plan sent to the agent.'}
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
                {mobile && <button type="button" role="tab" aria-selected={view === 'bdd'} onClick={() => setView('bdd')} className={`px-3 py-1.5 rounded text-xs font-medium ${view === 'bdd' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}>BDD test plan</button>}
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
              <Button variant="success" onClick={onApprove} disabled={approving || (mobile && !task.bddPlan)}>
                {mobile ? 'Approve Both Plans' : 'Approve Plan'}
              </Button>
            )}
          </div>
        </div>

        {view === 'bdd' ? (
          <div className="p-5 rounded-lg bg-muted border border-border">
            {task.bddPlan ? <><Markdown>{task.bddPlan.plan}</Markdown><div className="space-y-3 mt-4">{task.bddPlan.scenarios.map((scenario) => <div key={scenario.id} className="border-t border-border pt-3 text-xs"><p className="font-semibold">{scenario.id}</p><p><strong>Given</strong> {scenario.given}</p><p><strong>When</strong> {scenario.when}</p><p><strong>Then</strong> {scenario.then}</p></div>)}</div></> : <p className="text-sm text-muted-foreground">No BDD plan is available yet.</p>}
          </div>
        ) : task.plan && overview && view === 'summary' ? (
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
        {mobile && canApprove && onFeedback && <form className="space-y-3 border-t border-border pt-4" onSubmit={(event) => {
          event.preventDefault();
          if (!feedback.trim()) return;
          setFeedbackError(null);
          void onFeedback(feedback.trim(), target).then(() => setFeedback('')).catch((error: unknown) => setFeedbackError(error instanceof Error ? error.message : 'Could not request plan changes'));
        }}>
          <label className="block text-xs">Feedback for
            <select aria-label="Feedback for" value={target} onChange={(event) => setTarget(event.target.value as 'bdd' | 'implementation')} className="block mt-1 w-full rounded border border-border bg-input p-2">
              <option value="implementation">Implementation plan</option><option value="bdd">BDD test plan</option>
            </select>
          </label>
          <textarea aria-label="Plan feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} className="w-full rounded border border-border bg-input p-3 text-sm" placeholder="Describe the changes you want to review…" required maxLength={20000} />
          <p className="text-xs text-muted-foreground">BDD revisions also update the implementation plan so both remain consistent.</p>
          {feedbackError && <p role="alert" className="text-xs text-[#f87171]">{feedbackError}</p>}
          <Button type="submit" disabled={!feedback.trim() || sendingFeedback} loading={sendingFeedback}>Request plan changes</Button>
        </form>}
      </div>
    </div>
  );
}
