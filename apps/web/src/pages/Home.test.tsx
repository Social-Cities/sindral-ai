import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MOBILE_APP_WORKFLOW } from '@sindral/shared';
import * as api from '@/lib/api';
import { renderWithProviders } from '@/test/utils';
import { makeTask, workflowRecord } from '@/test/fixtures';
import { Home } from './Home';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    listTasks: vi.fn(),
    listProjects: vi.fn(),
    listWorkflows: vi.fn(),
    listWorkers: vi.fn(),
    getMe: vi.fn(),
    getGitHubCatalog: vi.fn(),
    importTicket: vi.fn(),
    createProject: vi.fn(),
    createTask: vi.fn(),
  };
});

describe('Home', () => {
  beforeEach(() => {
    vi.mocked(api.listTasks).mockResolvedValue({ tasks: [makeTask({ state: 'todo' }), makeTask({ state: 'in-review', currentStepId: 'in-review' })] });
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [] });
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord()] });
    vi.mocked(api.listWorkers).mockResolvedValue({ workers: [] });
    vi.mocked(api.getMe).mockResolvedValue({ user: { id: 'user-1', email: 'lucas@example.com', displayName: 'Lucas' } });
    vi.mocked(api.getGitHubCatalog).mockResolvedValue({ connected: false, source: null, repositories: [], owners: [] });
    vi.mocked(api.createProject).mockReset();
    vi.mocked(api.createTask).mockReset();
    vi.mocked(api.importTicket).mockReset();
  });

  it('greets the user and shows stat counts and the worker hint', async () => {
    renderWithProviders(<Home />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/Good (morning|afternoon|evening|night), Lucas\./);
    await waitFor(() => expect(screen.getByRole('link', { name: /Tasks in Todo/ })).toHaveTextContent(/^1Tasks in Todo/));
    expect(screen.getByRole('link', { name: /In Progress/ })).toHaveTextContent(/^0In Progress/);
    expect(screen.getByRole('link', { name: /Needs approval/ })).toHaveTextContent(/^1In Review/);
    expect(await screen.findByText(/No worker connected/)).toBeInTheDocument();
  });

  it('imports a ticket URL and pre-fills the form before creating the task', async () => {
    const user = userEvent.setup();
    vi.mocked(api.importTicket).mockResolvedValue({
      ticket: { provider: 'linear', id: 'ENG-123', title: 'Fix login redirect', description: 'Users land on /404 after login.', url: 'https://linear.app/acme/issue/ENG-123' },
    });
    vi.mocked(api.createTask).mockResolvedValue({ task: makeTask({ key: 'ENG-123' }) });
    renderWithProviders(<Home />);

    await user.click(await screen.findByRole('tab', { name: 'Paste a URL' }));
    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();
    await user.type(screen.getByLabelText('Ticket URL'), 'https://linear.app/acme/issue/ENG-123');
    expect(screen.getByText(/Detected a Linear ticket \(ENG-123\)/)).toBeInTheDocument();
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    expect(api.importTicket).toHaveBeenCalledWith('https://linear.app/acme/issue/ENG-123');
    expect(await screen.findByLabelText('Imported title')).toHaveValue('Fix login redirect');
    expect(screen.getByLabelText('Imported description')).toHaveValue('Users land on /404 after login.');
    expect(screen.getByText('Linear')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Repositories'), 'acme/app, https://github.com/acme/web');
    await user.click(screen.getByRole('button', { name: /Create task/ }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(api.createTask).toHaveBeenCalledWith({
      title: 'Fix login redirect',
      description: 'Users land on /404 after login.',
      ticketUrl: 'https://linear.app/acme/issue/ENG-123',
      key: 'ENG-123',
      repos: ['acme/app', 'acme/web'],
      workflowId: 'wf-default',
    });
  });

  it('rejects invalid repositories client-side', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Home />);
    await user.type(await screen.findByLabelText('Task description'), 'Write docs');
    await user.type(screen.getByLabelText('Repositories'), 'not a repo');
    await user.click(screen.getByRole('button', { name: /Create task/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('is not a valid repository');
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('creates a text task with the first line as title (Cmd+Enter)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createTask).mockResolvedValue({ task: makeTask() });
    renderWithProviders(<Home />);
    const textarea = await screen.findByLabelText('Task description');
    await user.type(textarea, 'Add dark mode{Shift>}{Enter}{/Shift}Respect system preference.');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(api.createTask).toHaveBeenCalledWith({
      title: 'Add dark mode',
      description: 'Add dark mode\nRespect system preference.',
      repos: [],
      workflowId: 'wf-default',
    });
  });

  it('creates a task under an existing project and inherits its repositories', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{
        id: 'project-1',
        userId: 'user-1',
        name: 'Billing platform',
        description: 'Billing work',
        projectType: 'standard', platforms: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        repositories: [
          { id: 'repo-1', userId: 'user-1', projectId: 'project-1', repository: 'acme/billing-platform', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }],
    });
    vi.mocked(api.createTask).mockResolvedValue({ task: makeTask({ projectId: 'project-1', repos: ['acme/billing-platform'] }) });
    renderWithProviders(<Home />);

    await user.type(await screen.findByLabelText('Task description'), 'Build the billing service');
    await screen.findByText(/1 repos/);
    await user.click(screen.getByRole('button', { name: /Create task/ }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({
      title: 'Build the billing service',
      description: 'Build the billing service',
      projectId: 'project-1',
      repos: ['acme/billing-platform'],
      workflowId: 'wf-default',
    }));
  });

  it('creates a new project from the home project tab', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getGitHubCatalog).mockResolvedValue({
      connected: true,
      source: 'oauth',
      repositories: [],
      owners: [
        { login: 'lucas', type: 'user', avatarUrl: null, role: 'owner' },
        { login: 'acme', type: 'organization', avatarUrl: null, role: 'admin' },
      ],
    });
    vi.mocked(api.createProject).mockResolvedValue({
      project: {
        id: 'project-1',
        userId: 'user-1',
        name: 'Billing platform',
        description: 'Billing work',
        projectType: 'standard', platforms: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        repositories: [
          { id: 'repo-1', userId: 'user-1', projectId: 'project-1', repository: 'acme/billing-platform', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });
    renderWithProviders(<Home />);

    await user.click(await screen.findByRole('tab', { name: 'New project' }));
    await user.type(screen.getByLabelText('App title'), 'Billing platform');
    await user.type(screen.getByLabelText('Description'), 'Billing work');
    await user.selectOptions(screen.getByLabelText('Repository owner'), 'acme');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: 'Billing platform',
      description: 'Billing work',
      repository: {
        owner: 'acme',
        name: 'billing-platform',
        visibility: 'private',
        description: 'Billing work',
      },
    }));
    expect(await screen.findByText('Created project and initialized acme/billing-platform.')).toBeInTheDocument();
  });

  it('creates a new project from existing GitHub repositories', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getGitHubCatalog).mockResolvedValue({
      connected: true,
      source: 'oauth',
      repositories: [
        {
          id: 1,
          name: 'api',
          fullName: 'acme/api',
          private: true,
          description: null,
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          pushedAt: '2026-01-01T00:00:00.000Z',
          owner: 'acme',
        },
        {
          id: 2,
          name: 'web',
          fullName: 'acme/web',
          private: false,
          description: null,
          url: 'https://github.com/acme/web',
          defaultBranch: 'main',
          pushedAt: '2026-01-01T00:00:00.000Z',
          owner: 'acme',
        },
      ],
      owners: [{ login: 'acme', type: 'organization', avatarUrl: null, role: 'admin' }],
    });
    vi.mocked(api.createProject).mockResolvedValue({
      project: {
        id: 'project-1',
        userId: 'user-1',
        name: 'Platform',
        description: 'Platform work',
        projectType: 'standard', platforms: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        repositories: [
          { id: 'repo-1', userId: 'user-1', projectId: 'project-1', repository: 'acme/api', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'repo-2', userId: 'user-1', projectId: 'project-1', repository: 'acme/web', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });
    renderWithProviders(<Home />);

    await user.click(await screen.findByRole('tab', { name: 'New project' }));
    await user.click(screen.getByRole('button', { name: 'Use existing repos' }));
    await user.type(screen.getByLabelText('App title'), 'Platform');
    await user.type(screen.getByLabelText('Description'), 'Platform work');
    await user.click(screen.getByRole('checkbox', { name: /acme\/api/ }));
    await user.click(screen.getByRole('checkbox', { name: /acme\/web/ }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: 'Platform',
      description: 'Platform work',
      repos: ['acme/api', 'acme/web'],
    }));
    expect(await screen.findByText('Created project using 2 repositories.')).toBeInTheDocument();
  });
  it('selects the mobile workflow when project data arrives first and creates a task-selected subset', async () => {
    const user = userEvent.setup();
    let releaseWorkflows = () => {};
    vi.mocked(api.listWorkflows).mockImplementation(() => new Promise((resolve) => { releaseWorkflows = () => resolve({ workflows: [workflowRecord(), workflowRecord(MOBILE_APP_WORKFLOW, { id: 'mobile', isDefault: false })] }); }));
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [{
      id: 'mobile-project', userId: 'user-1', name: 'Mobile app', description: '', projectType: 'mobile-app', platforms: ['ios', 'android', 'web'],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      repositories: [{ id: 'repo', userId: 'user-1', projectId: 'mobile-project', repository: 'acme/app', createdAt: '', updatedAt: '' }],
    }] });
    vi.mocked(api.createTask).mockResolvedValue({ task: makeTask({ platforms: ['ios', 'web'] }) });
    renderWithProviders(<Home />);
    await screen.findByText('1 repos · acme/app');
    await act(async () => { releaseWorkflows(); });
    await user.type(await screen.findByLabelText('Task description'), 'Change account preferences');
    await user.click(await screen.findByRole('checkbox', { name: 'Android' }));
    expect(screen.getByRole('checkbox', { name: 'iOS' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Web' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /Create task/ }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'mobile', projectId: 'mobile-project', platforms: ['ios', 'web'] })));
  });

});
