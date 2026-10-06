import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Workflow } from '@sindral/shared';
import { availableActions, getStep, isAgentActive } from '@sindral/shared';
import { displayNameFor, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/Button';
import type { ButtonVariant } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ExternalLink } from '@/components/ExternalLink';
import { Modal } from '@/components/Modal';
import { PageLoader, Spinner } from '@/components/Spinner';
import { StatusBadge } from '@/components/StatusBadge';
import { useDeleteTask, useRepinTaskWorkflow, useSendMessage, useStopAgent, useTask, useTaskAction } from '@/hooks/useTasks';
import { useWorkflows } from '@/hooks/useWorkflows';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { resolveWorkflow } from '@/lib/taskWorkflow';
import { ArtifactsTab } from './taskDetail/ArtifactsTab';
import { ChatTab } from './taskDetail/ChatTab';
import { CodeTab } from './taskDetail/CodeTab';
import { Pipeline } from './taskDetail/Pipeline';
import { PlanTab } from './taskDetail/PlanTab';
import { ReviewTab } from './taskDetail/ReviewTab';
import { StepsTab } from './taskDetail/StepsTab';
import { SummaryTab } from './taskDetail/SummaryTab';

type Tab = 'summary' | 'plan' | 'chat' | 'code' | 'review' | 'steps' | 'artifacts';

const TAB_LABELS: Record<Tab, string> = {
  summary: 'Summary',
  plan: 'Plan',
  chat: 'Chat',
  code: 'Code',
  review: 'Review',
  steps: 'Steps',
  artifacts: 'Artifacts',
};

/** Button styling per workflow event, matching the prototype's colours. */
export function variantForEvent(event: string): ButtonVariant {
  switch (event) {
    case 'start':
      return 'primary';
    case 'approve':
    case 'accept':
    case 'mark-done':
      return 'success';
    case 'mark-wont-do':
      return 'danger';
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

function workflowSnapshot(workflow: Workflow): Workflow {
  return {
    id: workflow.id,
    name: workflow.name,
    ...(workflow.description !== undefined ? { description: workflow.description } : {}),
    entryStepId: workflow.entryStepId,
    steps: workflow.steps,
    edges: workflow.edges,
    ...(workflow.troubleshootStep !== undefined ? { troubleshootStep: workflow.troubleshootStep } : {}),
  };
}

function workflowsMatch(a: Workflow, b: Workflow): boolean {
  return JSON.stringify(workflowSnapshot(a)) === JSON.stringify(workflowSnapshot(b));
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const taskQuery = useTask(id);
  const workflowsQuery = useWorkflows();
  const [pendingCloseEvent, setPendingCloseEvent] = useState<'mark-done' | 'mark-wont-do' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const task = taskQuery.data ?? null;
  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);
  const workflow: Workflow | null = useMemo(() => (task ? resolveWorkflow(task, workflows) : null), [task, workflows]);
  const liveWorkflow: Workflow | null = useMemo(() => (task?.workflowId ? workflows.find((wf) => wf.id === task.workflowId) ?? null : null), [task?.workflowId, workflows]);
  const pinnedWorkflowOutdated = Boolean(task?.pinnedWorkflow && liveWorkflow && !workflowsMatch(task.pinnedWorkflow, liveWorkflow));

  const action = useTaskAction(id ?? '', workflow);
  const repinWorkflow = useRepinTaskWorkflow(id ?? '');
  const send = useSendMessage(id ?? '', workflow);
  const stopAgent = useStopAgent(id ?? '');
  const deleteTask = useDeleteTask();

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
  const hasReviewStep = Boolean(
    workflow?.steps.some((workflowStep) => workflowStep.output === 'review' || workflowStep.output === 'review-slice') ||
      task.artifacts.some((artifact) => artifact.name === 'adversarial-review.md' || artifact.name === 'review-slices.json'),
  );
  const tabs: Tab[] = ['summary', 'plan', 'chat', 'code', ...(hasReviewStep ? (['review'] as Tab[]) : []), 'steps', 'artifacts'];
  const defaultTab: Tab = 'summary';
  const requestedTab = searchParams.get('tab') as Tab | null;
  const tab: Tab = requestedTab && tabs.includes(requestedTab) ? requestedTab : defaultTab;
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === defaultTab) params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const userInitial = (displayNameFor(user, 'U').charAt(0) || 'U').toUpperCase();
  const actionError = action.error ? errorMessage(action.error) : repinWorkflow.error ? errorMessage(repinWorkflow.error) : stopAgent.error ? errorMessage(stopAgent.error) : null;
  const deleteError = deleteTask.error ? errorMessage(deleteTask.error) : null;
  const canApprovePlan = actions.some((item) => item.event === 'approve');
  const approvePlan = () => action.mutate('approve');
  const runAction = (event: string) => {
    if (event === 'mark-done' || event === 'mark-wont-do') setPendingCloseEvent(event);
    else action.mutate(event);
  };
  const confirmClose = () => {
    if (!pendingCloseEvent) return;
    action.mutate(pendingCloseEvent);
    setPendingCloseEvent(null);
  };
  const confirmDelete = async () => {
    if (!id) return;
    try {
      await deleteTask.mutateAsync(id);
      setConfirmingDelete(false);
      navigate('/tasks');
    } catch {
      // The mutation keeps the error available for the confirmation dialog.
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between px-3 sm:px-5 min-h-11 py-2 border-b border-border gap-2 sm:gap-4">
        <Link to="/tasks" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-secondary-foreground transition-colors shrink-0">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to tasks
        </Link>

        <div className="flex items-center gap-2 min-w-0">
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
          {pinnedWorkflowOutdated && (
            <Button
              variant="ghost"
              onClick={() => repinWorkflow.mutate()}
              loading={repinWorkflow.isPending}
              disabled={agentActive || repinWorkflow.isPending}
              title={agentActive ? 'Wait for the running agent before updating the pinned workflow' : 'Update this task to the latest saved workflow version'}
            >
              Use latest workflow
            </Button>
          )}
          {actions.filter((a) => a.event !== 'approve' || (tab !== 'summary' && tab !== 'plan')).map((a) => (
            <Button key={a.event} variant={variantForEvent(a.event)} onClick={() => runAction(a.event)} disabled={action.isPending} data-event={a.event}>
              {a.label}
            </Button>
          ))}
          {agentActive && (
            <Button variant="warning" onClick={() => stopAgent.mutate()} loading={stopAgent.isPending} disabled={action.isPending || deleteTask.isPending}>
              Stop agent
            </Button>
          )}
          <Button variant="danger" onClick={() => setConfirmingDelete(true)} disabled={action.isPending || deleteTask.isPending}>
            Delete
          </Button>
          {agentActive && <Spinner label="Agent working…" />}
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left tab rail */}
        <aside className="w-full md:w-44 shrink-0 flex md:flex-col py-2 md:py-4 px-2 md:px-3 gap-1 border-b md:border-b-0 md:border-r border-border bg-muted overflow-x-auto md:overflow-visible">
          <p className="label-caps px-2 mb-2 hidden md:block">View</p>
          <div role="tablist" className="flex md:flex-col gap-1 shrink-0">
            {tabs.map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors border whitespace-nowrap ${
                  tab === t ? 'text-foreground bg-secondary border-border' : 'text-muted-foreground hover:text-secondary-foreground border-transparent'
                }`}
              >
                {TAB_LABELS[t]}
                {t === 'chat' && task.messages.length > 0 && <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">{task.messages.length}</span>}
              </button>
            ))}
          </div>

          <div className="mt-auto pt-4 border-t border-border hidden md:block">
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
                      background: task.pinnedWorkflow ? 'color-mix(in srgb, var(--color-success) 6%, transparent)' : 'var(--color-secondary)',
                      border: `1px solid ${task.pinnedWorkflow ? 'color-mix(in srgb, var(--color-success) 14%, transparent)' : 'var(--color-border)'}`,
                    }}
                  >
                    <span className="text-[10px] mt-px shrink-0" aria-hidden="true">
                      {task.pinnedWorkflow ? '📌' : '⬡'}
                    </span>
                    <div>
                      <p className="text-[10px] font-medium" style={{ color: task.pinnedWorkflow ? 'var(--color-success)' : 'var(--color-secondary-foreground)' }}>
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
          <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-border">
            <h1 className="text-lg font-semibold text-foreground tracking-tight leading-snug">{task.title}</h1>
            <Pipeline task={task} workflow={workflow} />
          </div>

          <div className="flex-1 overflow-hidden" role="tabpanel">
            {tab === 'summary' && (
              <SummaryTab
                task={task}
                workflow={workflow}
                canApprove={canApprovePlan}
                approving={action.isPending}
                onApprove={approvePlan}
                onViewPlan={() => setTab('plan')}
              />
            )}
            {tab === 'plan' && <PlanTab task={task} canApprove={canApprovePlan} approving={action.isPending} onApprove={approvePlan} />}
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
            {tab === 'review' && <ReviewTab task={task} />}
            {tab === 'steps' && <StepsTab task={task} workflow={workflow} agentActive={agentActive} />}
            {tab === 'artifacts' && <ArtifactsTab task={task} />}
          </div>
        </div>
      </div>

      <Modal
        open={pendingCloseEvent !== null}
        title={pendingCloseEvent === 'mark-done' ? 'Mark task done?' : "Mark task as won't do?"}
        onClose={() => setPendingCloseEvent(null)}
        footer={
          <>
            <Button variant="subtle" className="flex-1" onClick={() => setPendingCloseEvent(null)}>
              Cancel
            </Button>
            <Button variant={pendingCloseEvent === 'mark-done' ? 'success' : 'danger'} className="flex-1" onClick={confirmClose} loading={action.isPending}>
              {pendingCloseEvent === 'mark-done' ? 'Mark done' : "Won't do"}
            </Button>
          </>
        }
      >
        This stops queued work for the task and hides it from the default Active task view. If an agent is already working, wait for it to finish first. You can still find the task with the status filter.
      </Modal>

      <Modal
        open={confirmingDelete}
        title="Delete task?"
        onClose={() => !deleteTask.isPending && setConfirmingDelete(false)}
        footer={
          <>
            <Button variant="subtle" className="flex-1" onClick={() => setConfirmingDelete(false)} disabled={deleteTask.isPending}>
              Cancel
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => void confirmDelete()} loading={deleteTask.isPending}>
              Delete task
            </Button>
          </>
        }
      >
        <p>Deleting removes this task, its messages, jobs, and artifacts. This cannot be undone.</p>
        {deleteError && (
          <p className="mt-3 text-[#f87171]" role="alert">
            {deleteError}
          </p>
        )}
      </Modal>
    </div>
  );
}
