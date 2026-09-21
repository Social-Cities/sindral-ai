import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { makeTask, workflowRecord } from '@/test/fixtures';
import { useTasks } from '@/hooks/useTasks';
import { useWorkflows } from '@/hooks/useWorkflows';
import { Tasks } from './Tasks';

vi.mock('@/hooks/useTasks', () => ({ useTasks: vi.fn() }));
vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: vi.fn() }));

const parent = makeTask({ id: 'p1', key: 'ENG-1', title: 'Add OAuth login', state: 'in-review', currentStepId: 'in-review', prUrl: 'https://github.com/acme/app/pull/12' });
const child = makeTask({ id: 'c1', key: 'ENG-1.1', title: 'Add token store', state: 'done', currentStepId: 'done', parentTaskId: 'p1', sequence: 1 });
const other = makeTask({ id: 'o1', key: 'ENG-2', title: 'Fix flaky test', state: 'todo', currentStepId: 'todo', ticketUrl: 'https://linear.app/acme/issue/ENG-2' });

function mockData(tasks = [parent, child, other]) {
  vi.mocked(useTasks).mockReturnValue({ data: tasks, isLoading: false, isError: false, error: null } as unknown as ReturnType<typeof useTasks>);
  vi.mocked(useWorkflows).mockReturnValue({ data: [workflowRecord()], isLoading: false, isError: false, error: null } as unknown as ReturnType<typeof useWorkflows>);
}

describe('Tasks page', () => {
  beforeEach(() => mockData());

  it('lists top-level tasks with subtasks nested under their parent', () => {
    renderWithProviders(<Tasks />, { route: '/tasks' });
    const cards = screen.getAllByTestId('task-card');
    expect(cards).toHaveLength(3);
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    const nested = screen.getByLabelText('Subtasks of ENG-1');
    expect(within(nested).getByText('Add token store')).toBeInTheDocument();
    expect(screen.getByText('↳ 1/1')).toBeInTheDocument();
    expect(screen.getByText('PR open')).toBeInTheDocument();
    expect(screen.getByText('linked')).toBeInTheDocument();
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
    await user.click(screen.getByRole('option', { name: /^todo$/ }));
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
