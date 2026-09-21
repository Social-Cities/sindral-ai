import { useState } from 'react';
import type { Job, TaskEvent, TaskWithRelations, Workflow } from '@sindral/shared';
import { getStateStyle, getStep } from '@sindral/shared';
import { useJobLogs, useTaskJobs } from '@/hooks/useTasks';
import { formatDateTime } from '@/lib/format';

interface StepsTabProps {
  task: TaskWithRelations;
  workflow: Workflow | null;
  agentActive: boolean;
}

function eventTitle(ev: TaskEvent, workflow: Workflow | null): string {
  if (ev.fromState || ev.toState) {
    const from = ev.fromState ? getStateStyle(ev.fromState).label : '—';
    const to = ev.toState ? getStateStyle(ev.toState).label : '—';
    return `${from} → ${to}`;
  }
  const step = workflow && ev.stepId ? getStep(workflow, ev.stepId) : null;
  return step ? `${humanizeType(ev.type)} · ${step.label}` : humanizeType(ev.type);
}

function humanizeType(type: string): string {
  return type.replace(/[._-]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function detailString(detail: TaskEvent['detail']): string | null {
  if (!detail) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (k === 'actor' || k === 'event') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${String(v)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

function actorOf(ev: TaskEvent): string | null {
  const actor = ev.detail?.actor;
  return typeof actor === 'string' ? actor : null;
}

const JOB_STATUS_COLOR: Record<Job['status'], string> = {
  queued: '#8b92a8',
  claimed: '#fbbf24',
  running: '#a78bfa',
  completed: '#34d399',
  failed: '#f87171',
  cancelled: '#52596b',
};

export function StepsTab({ task, workflow, agentActive }: StepsTabProps) {
  const jobs = useTaskJobs(task.id, { live: agentActive });
  const events = [...task.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="overflow-y-auto h-full">
      <div className="p-5 grid grid-cols-1 xl:grid-cols-2 gap-8 max-w-5xl">
        <section>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Timeline</p>
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No events recorded yet.</p>
          ) : (
            <ol>
              {events.map((ev, i) => {
                const last = i === events.length - 1;
                const step = workflow && ev.stepId ? getStep(workflow, ev.stepId) : null;
                const actor = actorOf(ev);
                const detail = detailString(ev.detail);
                return (
                  <li key={ev.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: last ? '#818cf8' : '#1c1c30', border: '1px solid #2a2a44' }} aria-hidden="true" />
                      {!last && <div className="w-px flex-1 mt-1" style={{ background: '#1c1c30', minHeight: '24px' }} aria-hidden="true" />}
                    </div>
                    <div className="pb-5 min-w-0">
                      <p className="text-sm text-foreground font-medium">{eventTitle(ev, workflow)}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed flex flex-wrap gap-x-2">
                        <span className="font-mono">{ev.type}</span>
                        {step && (ev.fromState || ev.toState) && <span>step: {step.label}</span>}
                        {actor && <span>by {actor}</span>}
                        {detail && <span>{detail}</span>}
                      </p>
                      <p className="text-[10px] font-mono text-muted-foreground mt-1">{formatDateTime(ev.createdAt)}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Agent jobs</p>
          {jobs.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading jobs…</p>
          ) : jobs.isError ? (
            <p className="text-xs text-[#f87171]">Could not load jobs.</p>
          ) : (jobs.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No jobs have run for this task.</p>
          ) : (
            <div className="space-y-2">
              {[...(jobs.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => (
                <JobCard key={job.id} job={job} workflow={workflow} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function JobCard({ job, workflow }: { job: Job; workflow: Workflow | null }) {
  const [open, setOpen] = useState(false);
  const live = job.status === 'running' || job.status === 'claimed' || job.status === 'queued';
  const logs = useJobLogs(open ? job.id : null, { live: open && live });
  const step = workflow && job.stepId ? getStep(workflow, job.stepId) : null;
  const label =
    job.kind === 'rebase-stack'
      ? 'Rebase stack'
      : job.kind === 'resolve-rebase-conflict'
        ? 'Resolve rebase conflict'
        : step?.label ?? (job.payload.kind === 'agent' ? job.payload.step.label : 'Agent job');

  return (
    <div className="rounded-lg bg-card border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="text-sm text-foreground font-medium truncate">{label}</p>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
            attempt {job.attempt} · {formatDateTime(job.createdAt)}
            {job.workerId ? ` · worker ${job.workerId.slice(0, 8)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1.5" style={{ color: JOB_STATUS_COLOR[job.status], background: `${JOB_STATUS_COLOR[job.status]}14` }}>
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'animate-pulse' : ''}`} style={{ background: JOB_STATUS_COLOR[job.status] }} aria-hidden="true" />
            {job.status}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="border-t border-border">
          {job.error && (
            <pre className="m-3 text-[11px] font-mono whitespace-pre-wrap break-words text-red-200/70 bg-background/60 rounded p-3 border border-border">{job.error}</pre>
          )}
          {job.result && (
            <p className="mx-4 mt-3 text-xs text-secondary-foreground leading-relaxed">
              <span className="text-muted-foreground font-mono">{job.result.kind}:</span> {job.result.summary}
            </p>
          )}
          <div className="m-3 rounded bg-background/60 border border-border max-h-80 overflow-auto">
            {logs.isLoading ? (
              <p className="p-3 text-xs text-muted-foreground">Loading logs…</p>
            ) : logs.isError ? (
              <p className="p-3 text-xs text-[#f87171]">Could not load logs.</p>
            ) : (logs.data ?? []).length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No log output.</p>
            ) : (
              <ol className="p-3 space-y-0.5 text-[11px] font-mono leading-relaxed">
                {(logs.data ?? []).map((line) => (
                  <li key={line.id} className="flex gap-2">
                    <span className="text-muted-foreground/60 shrink-0 select-none">{new Date(line.createdAt).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={`shrink-0 w-14 ${line.type === 'message' ? 'text-accent' : line.type === 'progress' ? 'text-amber-300/80' : 'text-muted-foreground'}`}>
                      {line.type}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-[#a8b4cc]">{line.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
