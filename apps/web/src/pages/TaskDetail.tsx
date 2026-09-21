import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Workflow } from '@sindral/shared';
import { availableActions, getStep, isAgentActive } from '@sindral/shared';
import { displayNameFor, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/Button';
import type { ButtonVariant } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ExternalLink } from '@/components/ExternalLink';
import { PageLoader, Spinner } from '@/components/Spinner';
import { StatusBadge } from '@/components/StatusBadge';
import { useSendMessage, useTask, useTaskAction } from '@/hooks/useTasks';
import { useWorkflows } from '@/hooks/useWorkflows';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { resolveWorkflow } from '@/lib/taskWorkflow';
import { ArtifactsTab } from './taskDetail/ArtifactsTab';
import { ChatTab } from './taskDetail/ChatTab';
import { CodeTab } from './taskDetail/CodeTab';
import { Pipeline } from './taskDetail/Pipeline';
import { StepsTab } from './taskDetail/StepsTab';
import { SubtasksTab } from './taskDetail/SubtasksTab';
import { SummaryTab } from './taskDetail/SummaryTab';

type Tab = 'summary' | 'chat' | 'code' | 'steps' | 'artifacts' | 'subtasks';

const TAB_LABELS: Record<Tab, string> = {
  summary: 'Summary',
  chat: 'Chat',
  code: 'Code',
  steps: 'Steps',
  artifacts: 'Artifacts',
  subtasks: 'Subtasks',
};

/** Button styling per workflow event, matching the prototype's colours. */
export function variantForEvent(event: string): ButtonVariant {
  switch (event) {
    case 'start':
      return 'primary';
    case 'approve':
    case 'accept':
      return 'success';
    case 'troubleshoot':
      return 'warning';
    case 'retry':
      return 'ghost';
    default:
      return 'primary';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const taskQuery = useTask(id);
  const workflowsQuery = useWorkflows();
  const [tab, setTab] = useState<Tab>('summary');

  const task = taskQuery.data ?? null;
  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);
  const workflow: Workflow | null = useMemo(() => (task ? resolveWorkflow(task, workflows) : null), [task, workflows]);

  const action = useTaskAction(id ?? '', workflow);
  const send = useSendMessage(id ?? '', workflow);

  if (taskQuery.isLoading) return <PageLoader label="Loading task…" />;
  if (taskQuery.isError || !task) {
    const notFound = taskQuery.error instanceof ApiError && taskQuery.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'Task not found.' : 'Could not load task'}
        description={!notFound && taskQuery.error ? errorMessage(taskQuery.error) : undefined}
        action={
          <Link to="/tasks" className="text-xs text-accent">
            ← Back to tasks
          </Link>
        }
      />
    );
  }

  const actions = availableActions(task, workflow);
  const agentActive = isAgentActive(task, workflow);
  const step = workflow ? getStep(workflow, task.currentStepId ?? workflow.entryStepId) : null;
  const tabs: Tab[] = ['summary', 'chat', 'code', 'steps', 'artifacts', ...(task.subtasks.length > 0 ? (['subtasks'] as Tab[]) : [])];
  const userInitial = (displayNameFor(user, 'U').charAt(0) || 'U').toUpperCase();
  const actionError = action.error ? errorMessage(action.error) : null;

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex items-center justify-between px-5 h-11 border-b border-border gap-4">
        <Link to="/tasks" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-secondary-foreground transition-colors shrink-0">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to tasks
        </Link>

        <div className="flex items-center gap-2 min-w-0">
          {task.parentTaskId && (
            <Link to={`/tasks/${task.parentTaskId}`} className="text-[10px] font-mono text-muted-foreground hover:text-accent">
              ↑ parent
            </Link>
          )}
          <span className="text-xs font-mono text-muted-foreground">{task.key}</span>
          <StatusBadge state={task.state} step={step} />
        </div>

        <div className="flex items-center gap-2 shrink-0" data-testid="task-actions">
          {actionError && (
            <span className="text-[10px] text-[#f87171] max-w-48 truncate" role="alert" title={actionError}>
              {actionError}
            </span>
          )}
          {task.prUrl && (
            <ExternalLink href={task.prUrl} className="px-3 py-1.5 text-xs font-mono rounded-md transition-all bg-secondary border border-border text-accent hover:border-border-strong">
              View PR ↗
            </ExternalLink>
          )}
          {actions.map((a) => (
            <Button key={a.event} variant={variantForEvent(a.event)} onClick={() => action.mutate(a.event)} disabled={action.isPending} data-event={a.event}>
              {a.label}
            </Button>
          ))}
          {agentActive && <Spinner label="Agent working…" />}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left tab rail */}
        <aside className="w-44 shrink-0 flex flex-col py-4 px-3 gap-1 border-r border-border bg-muted">
          <p className="label-caps px-2 mb-2">View</p>
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {tabs.map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors border ${
                  tab === t ? 'text-foreground bg-secondary border-border' : 'text-muted-foreground hover:text-secondary-foreground border-transparent'
                }`}
              >
                {TAB_LABELS[t]}
                {t === 'chat' && task.messages.length > 0 && <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">{task.messages.length}</span>}
                {t === 'subtasks' && <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">{task.subtasks.length}</span>}
              </button>
            ))}
          </div>

          <div className="mt-auto pt-4 border-t border-border">
            <p className="label-caps px-2 mb-2">Info</p>
            <div className="px-2 space-y-2.5">
              <div>
                <p className="text-[10px] text-muted-foreground">Created</p>
                <p className="text-[10px] font-mono text-secondary-foreground">{formatDate(task.createdAt)}</p>
              </div>
              {task.ticketUrl && (
                <div>
                  <p className="text-[10px] text-muted-foreground">Ticket</p>
                  <ExternalLink
                    href={task.ticketUrl}
                    className="text-[10px] font-mono text-accent hover:text-accent/70 transition-colors"
                    fallback={<span className="text-[10px] font-mono text-muted-foreground">{task.key}</span>}
                  >
                    {task.key} ↗
                  </ExternalLink>
                </div>
              )}
              {workflow && (
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Workflow</p>
                  <div
                    className="flex items-start gap-1.5 px-2 py-1.5 rounded"
                    style={{
                      background: task.pinnedWorkflow ? '#34d39908' : '#13132a',
                      border: `1px solid ${task.pinnedWorkflow ? '#34d39920' : '#1c1c30'}`,
                    }}
                  >
                    <span className="text-[10px] mt-px shrink-0" aria-hidden="true">
                      {task.pinnedWorkflow ? '📌' : '⬡'}
                    </span>
                    <div>
                      <p className="text-[10px] font-medium" style={{ color: task.pinnedWorkflow ? '#34d399' : '#8b92a8' }}>
                        {workflow.name}
                      </p>
                      <p className="text-[9px] text-muted-foreground mt-0.5 leading-relaxed">
                        {task.pinnedWorkflow
                          ? "Pinned — changes to this workflow won't affect this task"
                          : task.state === 'todo'
                            ? 'Will be pinned when task starts'
                            : 'Live workflow'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Right content */}
        <div className="flex-1 overflow-hidden flex flex-col min-w-0">
          <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
            <h1 className="text-lg font-semibold text-foreground tracking-tight leading-snug">{task.title}</h1>
            <Pipeline task={task} workflow={workflow} />
          </div>

          <div className="flex-1 overflow-hidden" role="tabpanel">
            {tab === 'summary' && <SummaryTab task={task} workflow={workflow} />}
            {tab === 'chat' && (
              <ChatTab
                task={task}
                workflow={workflow}
                userInitial={userInitial}
                onSend={(content) => send.mutate(content)}
                sending={send.isPending}
                error={send.error ? errorMessage(send.error) : null}
              />
            )}
            {tab === 'code' && <CodeTab task={task} />}
            {tab === 'steps' && <StepsTab task={task} workflow={workflow} agentActive={agentActive} />}
            {tab === 'artifacts' && <ArtifactsTab task={task} />}
            {tab === 'subtasks' && <SubtasksTab task={task} workflows={workflows} />}
          </div>
        </div>
      </div>
    </div>
  );
}
