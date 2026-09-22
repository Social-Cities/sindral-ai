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
    sendMessage: vi.fn(),
    getTaskJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    getJobLogs: vi.fn().mockResolvedValue({ logs: [] }),
    getTaskDiff: vi.fn().mockResolvedValue({ files: [] }),
  };
});

function setup(task: TaskWithRelations) {
  vi.mocked(api.getTask).mockResolvedValue({ task });
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord()] });
  return renderWithProviders(<TaskDetail />, { route: `/tasks/${task.id}`, path: '/tasks/:id' });
}

describe('TaskDetail', () => {
  beforeEach(() => {
    vi.mocked(api.runTaskAction).mockReset();
    vi.mocked(api.sendMessage).mockReset();
  });

  it('offers "Start Planning" for a todo task', async () => {
    setup(makeTaskWithRelations({ id: 't1', state: 'todo', currentStepId: 'todo' }));
    const button = await screen.findByRole('button', { name: 'Start Planning' });
    expect(button).toHaveClass('bg-primary');
    expect(screen.queryByText('Agent working…')).not.toBeInTheDocument();
  });

  it('offers "Approve Plan" on plan review and shows the plan', async () => {
    setup(
      makeTaskWithRelations({
        id: 't2',
        state: 'plan-review',
        currentStepId: 'plan-review',
        pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW),
        plan: '# Plan\n\n- step one',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Approve Plan' })).toBeInTheDocument();
    expect(screen.getByText('step one')).toBeInTheDocument();
    expect(screen.getByText(/Pinned — changes to this workflow/)).toBeInTheDocument();
  });

  it('shows the spinner and no buttons while an agent is working', async () => {
    setup(makeTaskWithRelations({ id: 't3', state: 'implement', currentStepId: 'implement', pinnedWorkflow: snapshotWorkflow(FULL_SDLC_WORKFLOW) }));
    expect(await screen.findByText('Agent working…')).toBeInTheDocument();
    const actions = screen.getByTestId('task-actions');
    expect(within(actions).queryAllByRole('button')).toHaveLength(0);
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
