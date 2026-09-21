import type { TaskWithRelations, Workflow } from '@sindral/shared';
import { getStateStyle, getStep, isAgentActive } from '@sindral/shared';
import { Markdown } from '@/components/Markdown';
import { ExternalLink } from '@/components/ExternalLink';
import { shortPrLabel } from '@/lib/format';

interface SummaryTabProps {
  task: TaskWithRelations;
  workflow: Workflow | null;
}

export function SummaryTab({ task, workflow }: SummaryTabProps) {
  const agentActive = isAgentActive(task, workflow);
  const step = workflow ? getStep(workflow, task.currentStepId ?? workflow.entryStepId) : null;
  const style = getStateStyle(task.state, step);

  return (
    <div className="overflow-y-auto h-full p-6">
      <div className="max-w-2xl space-y-6">
        <section>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Description</p>
          {task.description ? (
            <Markdown>{task.description}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground italic">No description.</p>
          )}
        </section>

        {task.repos.length > 0 && (
          <section>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Repositories</p>
            <div className="flex flex-wrap gap-1.5">
              {task.repos.map((r) => (
                <span key={r} className="text-[11px] font-mono px-2 py-1 rounded bg-secondary border border-border text-secondary-foreground">
                  {r}
                </span>
              ))}
            </div>
          </section>
        )}

        {task.plan && (
          <section>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Implementation Plan</p>
            <div className="p-4 rounded-lg bg-muted border border-border">
              <Markdown>{task.plan}</Markdown>
            </div>
          </section>
        )}

        {task.prUrl && (
          <section>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Pull Request</p>
            <ExternalLink
              href={task.prUrl}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-mono transition-colors bg-input text-accent"
              style={{ border: '1px solid #818cf830' }}
              fallback={<span className="text-xs text-muted-foreground font-mono">{task.prUrl}</span>}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="4" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="10" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 5.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M5.5 4H8.5C8.5 4 8.5 7 5.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              {shortPrLabel(task.prUrl)}
            </ExternalLink>
            {task.branch && (
              <p className="text-[10px] font-mono text-muted-foreground mt-1.5">
                {task.branch}
                {task.baseBranch ? ` → ${task.baseBranch}` : ''}
              </p>
            )}
          </section>
        )}

        {task.state === 'todo' && (
          <div className="p-4 rounded-lg text-sm bg-secondary border border-border">
            <p className="text-secondary-foreground">
              This task is ready to start. Use the action button above to hand it to the first agent.
            </p>
          </div>
        )}

        {agentActive && (
          <div className="flex items-start gap-3 p-4 rounded-lg" style={{ background: '#fbbf2408', border: '1px solid #fbbf2420' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse mt-1.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-amber-200/80">Agent is working</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {task.state === 'troubleshoot'
                  ? 'The troubleshooting agent is diagnosing what went wrong.'
                  : step
                    ? `${step.label} is running on your worker (${style.label}).`
                    : 'An agent is running on your worker.'}
              </p>
            </div>
          </div>
        )}

        {!agentActive && step?.type === 'human' && task.state !== 'todo' && (
          <div className="p-4 rounded-lg bg-secondary border border-border">
            <p className="text-sm font-medium text-foreground">Waiting for you</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {step.label}: use the action buttons above, or send chat feedback to request changes.
            </p>
          </div>
        )}

        {task.state === 'failure' && (
          <div className="p-4 rounded-lg" style={{ background: '#f8711808', border: '1px solid #f8711820' }}>
            <p className="text-sm font-medium text-red-300/80 mb-1">Task failed</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              The agent ran into an error it couldn't resolve. Use the chat to provide guidance, retry the step, or run the troubleshoot agent.
            </p>
            {task.lastError && (
              <pre className="mt-3 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words text-red-200/70 bg-background/60 rounded p-3 border border-border max-h-64 overflow-auto">
                {task.lastError}
              </pre>
            )}
          </div>
        )}

        {task.state === 'done' && (
          <div className="p-4 rounded-lg" style={{ background: '#34d39908', border: '1px solid #34d39920' }}>
            <p className="text-sm font-medium text-emerald-300/80">Task complete</p>
            <p className="text-xs text-muted-foreground mt-0.5">All work has been accepted.</p>
          </div>
        )}
      </div>
    </div>
  );
}
