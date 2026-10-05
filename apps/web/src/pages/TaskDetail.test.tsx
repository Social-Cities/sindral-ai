import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskWithRelations } from '@sindral/shared';
import { FULL_SDLC_WORKFLOW, snapshotWorkflow } from '@sindral/shared';
import * as api from '@/lib/api';
import { renderWithProviders } from '@/test/utils';
import { makeMessage, makeTaskWithRelations, workflowRecord } from '@/test/fixtures';
import { TaskDetail } from './TaskDetail';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    getTask: vi.fn(),
    listWorkflows: vi.fn(),
    runTaskAction: vi.fn(),
    repinTaskWorkflow: vi.fn(),
    sendMessage: vi.fn(),
    deleteTask: vi.fn(),
    getTaskJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    getJobLogs: vi.fn().mockResolvedValue({ logs: [] }),
    getTaskDiff: vi.fn().mockResolvedValue({ files: [] }),
  };
});

function setup(task: TaskWithRelations, workflows = [workflowRecord()], route = `/tasks/${task.id}`) {
  vi.mocked(api.getTask).mockResolvedValue({ task });
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows });
  return renderWithProviders(<TaskDetail />, { route, path: '/tasks/:id' });
}

describe('TaskDetail', () => {
  beforeEach(() => {
    vi.mocked(api.runTaskAction).mockReset();
    vi.mocked(api.repinTaskWorkflow).mockReset();
    vi.mocked(api.sendMessage).mockReset();
    vi.mocked(api.deleteTask).mockReset();
  });

  it('offers "Start Planning" for a todo task', async () => {
    setup(makeTaskWithRelations({ id: 't1', state: 'todo', currentStepId: 'todo' }));
    const button = await screen.findByRole('button', { name: 'Start Planning' });
    expect(button).toHaveClass('bg-primary');
    expect(screen.queryByText('Agent working…')).not.toBeInTheDocument();
  });

  it('offers "Approve Plan" on plan review and shows the plan', async () => {
    const user = userEvent.setup();
    vi.mocked(api.runTaskAction).mockReturnValue(new Promise(() => undefined));
    setup(
      makeTaskWithRelations({
        id: 't2',
        state: 'plan-review',
        currentStepId: 'plan-review',
        pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
        outcome: 'A better result.',
        acceptanceCriteria: '- Tests pass.',
        plan:
          '# Plan\n\n## What behavior is changing\nStep one.\n\n## What files/systems are affected\n- apps/web/src/pages/taskDetail/PlanTab.tsx\n\n## Important invariants\n- API remains stable.\n\n| Assumption | Risk |\n| --- | --- |\n| Existing API | Low |\n\n## Edge cases\n- Empty plans still show an empty state.\n\n## How correctness will be verified\n- Tests pass.\n\n## Steps\n- full detail',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Approve Plan' })).toBeInTheDocument();
    expect(screen.getByText('Step one.')).toBeInTheDocument();
    expect(screen.getByText('Plan at a glance')).toBeInTheDocument();
    expect(screen.getByText('Affected files/systems')).toBeInTheDocument();
    expect(screen.getByText('apps/web/src/pages/taskDetail/PlanTab.tsx')).toBeInTheDocument();
    expect(screen.getAllByText('Tests pass.').length).toBeGreaterThan(0);
    expect(screen.queryByText('full detail')).not.toBeInTheDocument();
    expect(screen.getByText(/Pinned — changes to this workflow/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Plan' }));
    expect(screen.getAllByRole('tab', { name: 'Summary' }).some((node) => node.getAttribute('aria-selected') === 'true')).toBe(true);
    expect(screen.getByText('What behavior is changing')).toBeInTheDocument();
    expect(screen.getByText('API remains stable.')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('full detail')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Implementation plan' }));
    expect(screen.getByText('full detail')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve Plan' }));
    expect(api.runTaskAction).toHaveBeenCalledWith('t2', 'approve', 0);
  });

  it('shows the spinner and closure actions while an agent is working', async () => {
    setup(makeTaskWithRelations({ id: 't3', state: 'implement', currentStepId: 'implement', pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW) }));
    expect(await screen.findByText('Agent working…')).toBeInTheDocument();
    const summaryStatus = screen.getByText('Agent is working');
    const description = screen.getByText('Description');
    expect(summaryStatus.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const actions = screen.getByTestId('task-actions');
    expect(within(actions).getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: "Won't do" })).toBeInTheDocument();
  });

  it('confirms before marking a task as done or wont-do', async () => {
    const user = userEvent.setup();
    vi.mocked(api.runTaskAction).mockReturnValue(new Promise(() => undefined));
    setup(makeTaskWithRelations({ id: 'close-me', state: 'todo', currentStepId: 'todo' }));

    await user.click(await screen.findByRole('button', { name: "Won't do" }));
    const dialog = screen.getByRole('dialog', { name: "Mark task as won't do?" });
    expect(within(dialog).getByText(/hides it from the default Active task view/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: "Won't do" }));

    expect(api.runTaskAction).toHaveBeenCalledWith('close-me', 'mark-wont-do', 0);
  });

  it('confirms before deleting a task', async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteTask).mockResolvedValue({ ok: true });
    setup(makeTaskWithRelations({ id: 'delete-me', state: 'todo', currentStepId: 'todo' }));

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete task?' });
    expect(within(dialog).getByText(/removes this task, its messages, jobs, and artifacts/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }));

    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith('delete-me'));
  });

  it('offers Troubleshoot and Retry on failure and shows the error', async () => {
    setup(
      makeTaskWithRelations({
        id: 't4',
        state: 'failure',
        currentStepId: 'implement',
        failedStepId: 'implement',
        lastError: 'Permission denied: .github/workflows',
        pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
      }),
    );
    expect(await screen.findByRole('button', { name: 'Troubleshoot' })).toHaveClass('bg-[#f97316]');
    expect(screen.getByRole('button', { name: 'Retry step' })).toBeInTheDocument();
    expect(screen.getByText('Permission denied: .github/workflows')).toBeInTheDocument();
    expect(screen.getByTestId('pipeline-offpath')).toHaveTextContent('Failed');
  });

  it('offers to update an outdated pinned workflow snapshot', async () => {
    const user = userEvent.setup();
    const liveWorkflow = workflowRecord({ ...FULL_SDLC_WORKFLOW, name: 'Full SDLC v2' });
    const task = makeTaskWithRelations({
      id: 'repin-me',
      version: 7,
      state: 'failure',
      currentStepId: 'implement',
      failedStepId: 'implement',
      pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
    });
    vi.mocked(api.repinTaskWorkflow).mockResolvedValue({ task: { ...task, pinnedWorkflow: snapshotWorkflow(liveWorkflow), version: 8 } });
    setup(task, [liveWorkflow]);

    await user.click(await screen.findByRole('button', { name: 'Use latest workflow' }));
    expect(api.repinTaskWorkflow).toHaveBeenCalledWith('repin-me', 7);
  });

  it('offers Accept & merge and a View PR link on in-review', async () => {
    setup(
      makeTaskWithRelations({
        id: 't5',
        state: 'in-review',
        currentStepId: 'in-review',
        prUrl: 'https://github.com/acme/app/pull/7',
        pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
      }),
    );
    expect(await screen.findByRole('button', { name: 'Accept & merge' })).toHaveClass('bg-[#047857]');
    const link = screen.getByRole('link', { name: 'View PR ↗' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/7');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('shows adversarial review output in a dedicated Review tab', async () => {
    const user = userEvent.setup();
    setup(
      makeTaskWithRelations({
        id: 'reviewed-task',
        state: 'in-review',
        currentStepId: 'in-review',
        pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
        artifacts: [
          {
            id: 'review-artifact',
            taskId: 'reviewed-task',
            jobId: null,
            name: 'adversarial-review.md',
            contentType: 'text/markdown',
            content: '## Diff explanation\nThe implementation updates task detail navigation.\n\n## Findings ordered by severity\nNo material findings.',
            byteSize: 116,
            downloadUrl: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    await user.click(await screen.findByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('list', { name: 'Reviews' })).toBeInTheDocument();
    expect(screen.getByText('The implementation updates task detail navigation.')).toBeInTheDocument();
    expect(screen.queryByText('No material findings.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Adversarial review/ }));
    expect(screen.getByText('No material findings.')).toBeInTheDocument();
    expect(screen.queryByText('The implementation updates task detail navigation.')).not.toBeInTheDocument();
  });

  it('runs an action optimistically and rolls back on error', async () => {
    const user = userEvent.setup();
    let reject: (e: Error) => void = () => undefined;
    vi.mocked(api.runTaskAction).mockReturnValue(new Promise((_res, rej) => (reject = rej)));
    const task = makeTaskWithRelations({ id: 't6', state: 'todo', currentStepId: 'todo' });
    vi.mocked(api.getTask).mockResolvedValue({ task });
    setup(task);
    await user.click(await screen.findByRole('button', { name: 'Start Planning' }));
    expect(screen.getByTestId('status-badge')).toHaveTextContent('Planning');
    expect(api.runTaskAction).toHaveBeenCalledWith('t6', 'start', 0);
    reject(new api.ApiError(409, 'INVALID_EVENT', 'Nope'));
    await waitFor(() => expect(screen.getByTestId('status-badge')).toHaveTextContent('Todo'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
  });

  it('sends a chat message that optimistically transitions to the feedback state', async () => {
    const user = userEvent.setup();
    const task = makeTaskWithRelations({
      id: 't7',
      state: 'plan-review',
      currentStepId: 'plan-review',
      pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
      messages: [makeMessage({ taskId: 't7', content: 'Here is the plan.' })],
    });
    let resolve: (v: Awaited<ReturnType<typeof api.sendMessage>>) => void = () => undefined;
    vi.mocked(api.sendMessage).mockReturnValue(new Promise((res) => (resolve = res)));
    setup(task);

    await user.click(await screen.findByRole('tab', { name: /Chat/ }));
    expect(screen.getByTestId('chat-hint')).toHaveTextContent('Sending will trigger an agent revision');
    await user.type(screen.getByLabelText('Message'), 'Please add tests{Enter}');

    expect(api.sendMessage).toHaveBeenCalledWith('t7', 'Please add tests');
    expect(screen.getByText('Please add tests')).toBeInTheDocument();
    expect(screen.getByText('sending…')).toBeInTheDocument();
    expect(screen.getByText('Got it — the worker is working on your request.')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge')).toHaveTextContent('Plan Feedback');
    expect(screen.getByText('Agent working…')).toBeInTheDocument();

    // The server confirms the transition; the post-settle refetch must return the new state too.
    const saved = makeMessage({ id: 'server-msg', taskId: 't7', role: 'user', source: 'web', content: 'Please add tests' });
    const confirmed = { ...task, state: 'planning-feedback', currentStepId: 'planning-feedback', messages: [...task.messages, saved] };
    vi.mocked(api.getTask).mockResolvedValue({ task: confirmed });
    resolve({ message: saved, task: confirmed });
    await waitFor(() => expect(screen.queryByText('sending…')).not.toBeInTheDocument());
    expect(screen.getByText('Please add tests')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge')).toHaveTextContent('Plan Feedback');
  });

  it('labels GitHub-sourced messages', async () => {
    const user = userEvent.setup();
    setup(
      makeTaskWithRelations({
        id: 't8',
        state: 'in-review',
        currentStepId: 'in-review',
        pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
        messages: [makeMessage({ taskId: 't8', role: 'user', source: 'github', content: 'LGTM but rename the var' })],
      }),
    );
    await user.click(await screen.findByRole('tab', { name: /Chat/ }));
    expect(screen.getByText('via GitHub')).toBeInTheDocument();
  });
});
