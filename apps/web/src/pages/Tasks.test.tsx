import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { makeTask, workflowRecord } from '@/test/fixtures';
import { useTasks } from '@/hooks/useTasks';
import { useWorkflows } from '@/hooks/useWorkflows';
import { useProjects } from '@/hooks/useProjects';
import { Tasks } from './Tasks';

vi.mock('@/hooks/useTasks', () => ({ useTasks: vi.fn() }));
vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: vi.fn() }));
vi.mock('@/hooks/useProjects', () => ({ useProjects: vi.fn() }));

const parent = makeTask({ id: 'p1', key: 'ENG-1', title: 'Add OAuth login', state: 'in-review', currentStepId: 'in-review', prUrl: 'https://github.com/acme/app/pull/12' });
const child = makeTask({ id: 'c1', key: 'ENG-1.1', title: 'Add token store', state: 'done', currentStepId: 'done', parentTaskId: 'p1', sequence: 1 });
const other = makeTask({ id: 'o1', key: 'ENG-2', title: 'Fix flaky test', state: 'todo', currentStepId: 'todo', ticketUrl: 'https://linear.app/acme/issue/ENG-2' });
const completed = makeTask({ id: 'd1', key: 'ENG-3', title: 'Shipped feature', state: 'done', currentStepId: 'done' });
const declined = makeTask({ id: 'w1', key: 'ENG-4', title: 'Old experiment', state: 'wont-do', currentStepId: 'todo' });

function mockData(tasks = [parent, child, other, completed, declined]) {
  vi.mocked(useTasks).mockReturnValue({ data: tasks, isLoading: false, isError: false, error: null } as unknown as ReturnType<typeof useTasks>);
  vi.mocked(useWorkflows).mockReturnValue({ data: [workflowRecord()], isLoading: false, isError: false, error: null } as unknown as ReturnType<typeof useWorkflows>);
  vi.mocked(useProjects).mockReturnValue({ data: [], isLoading: false, isError: false, error: null } as unknown as ReturnType<typeof useProjects>);
}

describe('Tasks page', () => {
  beforeEach(() => mockData());

  it('lists active top-level tasks and hides terminal tasks and subtasks by default', () => {
    renderWithProviders(<Tasks />, { route: '/tasks' });
    const cards = screen.getAllByTestId('task-card');
    expect(cards).toHaveLength(2);
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    expect(screen.queryByLabelText('Subtasks of ENG-1')).not.toBeInTheDocument();
    expect(screen.queryByText('Add token store')).not.toBeInTheDocument();
    expect(screen.queryByText('Shipped feature')).not.toBeInTheDocument();
    expect(screen.queryByText('Old experiment')).not.toBeInTheDocument();
    expect(screen.getByText('↳ 1/1')).toBeInTheDocument();
    expect(screen.getByText('PR open')).toBeInTheDocument();
    expect(screen.getByText('linked')).toBeInTheDocument();
    expect(screen.getByText('Add OAuth login').closest('a')).toHaveAttribute('href', '/tasks/p1?tab=subtasks');
    expect(screen.getByText('Fix flaky test').closest('a')).toHaveAttribute('href', '/tasks/o1');
  });

  it('shows terminal tasks through all-status and specific-status filters', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tasks />, { route: '/tasks' });

    await user.click(screen.getByLabelText('Filter by status'));
    await user.click(screen.getByRole('option', { name: 'All statuses' }));
    expect(screen.getByText('Shipped feature')).toBeInTheDocument();
    expect(screen.getByText('Old experiment')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Subtasks of ENG-1')).getByText('Add token store')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Filter by status'));
    await user.click(screen.getByRole('option', { name: /^Won't do$/ }));
    expect(screen.getByText('Old experiment')).toBeInTheDocument();
    expect(screen.queryByText('Shipped feature')).not.toBeInTheDocument();
  });

  it('promotes an active child instead of showing its terminal parent in the Active view', () => {
    const closedParent = makeTask({ id: 'closed-parent', key: 'ENG-5', title: 'Closed parent', state: 'wont-do' });
    const activeChild = makeTask({ id: 'active-child', key: 'ENG-5.1', title: 'Still active', state: 'planning', parentTaskId: closedParent.id, sequence: 1 });
    mockData([closedParent, activeChild]);

    renderWithProviders(<Tasks />, { route: '/tasks' });

    expect(screen.queryByText('Closed parent')).not.toBeInTheDocument();
    expect(screen.getByText('Still active')).toBeInTheDocument();
    expect(screen.getByText('1 task')).toBeInTheDocument();
  });

  it('filters by search text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tasks />, { route: '/tasks' });
    await user.type(screen.getByLabelText('Search tasks'), 'flaky');
    expect(screen.getByText('Fix flaky test')).toBeInTheDocument();
    expect(screen.queryByText('Add OAuth login')).not.toBeInTheDocument();
    expect(screen.getByText('1 task')).toBeInTheDocument();
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tasks />, { route: '/tasks' });
    await user.click(screen.getByLabelText('Filter by status'));
    await user.click(screen.getByRole('option', { name: /^Todo$/ }));
    expect(screen.getByText('Fix flaky test')).toBeInTheDocument();
    expect(screen.queryByText('Add OAuth login')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tasks />, { route: '/tasks' });
    await user.type(screen.getByLabelText('Search tasks'), 'zzz');
    expect(screen.getByText('No tasks match your filters')).toBeInTheDocument();
  });
});
