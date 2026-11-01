import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FULL_SDLC_WORKFLOW } from '@sindral/shared';
import * as api from '@/lib/api';
import { renderWithProviders } from '@/test/utils';
import { makeTask, workflowRecord } from '@/test/fixtures';
import { Workflows } from './Workflows';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    listWorkflows: vi.fn(),
    listTasks: vi.fn(),
    updateWorkflow: vi.fn(),
    createWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
  };
});

describe('Workflows editor', () => {
  beforeEach(() => {
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord()] });
    vi.mocked(api.listTasks).mockResolvedValue({
      tasks: [makeTask({ state: 'implement', currentStepId: 'implement', pinnedWorkflow: FULL_SDLC_WORKFLOW })],
    });
    vi.mocked(api.updateWorkflow).mockReset();
    vi.mocked(api.createWorkflow).mockReset();
    vi.mocked(api.deleteWorkflow).mockReset();
    vi.mocked(api.deleteWorkflow).mockResolvedValue({ ok: true });
  });

  it('renders the graph, disables Save when unchanged, and shows pinned counts', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    expect(await screen.findByRole('img', { name: 'Workflow graph for Full SDLC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/1 task pinned to this version/)).toBeInTheDocument());
    expect(screen.getByText('1 active')).toBeInTheDocument();
  });

  it('surfaces validation issues inline and keeps Save disabled until fixed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Workflows />, { route: '/workflows' });
    const node = await screen.findByTestId('node-planning');
    fireEvent.keyDown(node, { key: 'Enter' });

    const prompt = await screen.findByLabelText('Prompt');
    await user.clear(prompt);
    expect(screen.getByText('Agent steps need a prompt')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-issues')).toHaveTextContent('1 issue');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.type(prompt, 'Plan {{{{task_description}}}}');
    expect(screen.queryByText('Agent steps need a prompt')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('flags a missing end step at the workflow level', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Workflows />, { route: '/workflows' });
    const node = await screen.findByTestId('node-done');
    fireEvent.keyDown(node, { key: 'Enter' });
    await user.click(await screen.findByRole('button', { name: 'Delete step' }));
    expect(screen.getByTestId('workflow-issues')).toHaveTextContent('Workflow needs an end step');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a valid, changed draft with PUT /api/workflows/:id', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWorkflow).mockImplementation(async (id, input) => ({ workflow: workflowRecord({ ...FULL_SDLC_WORKFLOW, ...input, id }, { updatedAt: '2026-02-02T00:00:00.000Z' }) }));
    renderWithProviders(<Workflows />, { route: '/workflows' });
    const nameInput = await screen.findByLabelText('Workflow name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Full SDLC v2');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(api.updateWorkflow).toHaveBeenCalledTimes(1));
    const [id, body] = vi.mocked(api.updateWorkflow).mock.calls[0]!;
    expect(id).toBe('wf-default');
    expect(body.name).toBe('Full SDLC v2');
    expect('id' in body).toBe(false);
    expect(await screen.findByRole('button', { name: 'Saved ✓' })).toBeDisabled();
  });

  it('creates a workflow from scratch and opens it in the editor', async () => {
    const user = userEvent.setup();
    const created = workflowRecord({
      id: 'new-workflow', name: 'My workflow', entryStepId: 'todo',
      steps: [
        { id: 'todo', type: 'human', label: 'Start', state: 'todo' },
        { id: 'done', type: 'end', label: 'Done', state: 'done' },
      ],
      edges: [{ from: 'todo', to: 'done', event: 'complete' }],
    }, { isDefault: false });
    vi.mocked(api.createWorkflow).mockImplementation(async () => {
      vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord(), created] });
      return { workflow: created };
    });
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await user.click(await screen.findByRole('button', { name: 'New workflow' }));
    const dialog = screen.getByRole('dialog', { name: 'New workflow' });
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Workflow name'), 'My workflow');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledWith({ name: 'My workflow' }));
    expect(await screen.findByRole('img', { name: 'Workflow graph for My workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clones the selected saved workflow with a distinct name', async () => {
    const user = userEvent.setup();
    const copy = workflowRecord(FULL_SDLC_WORKFLOW, { id: 'copy-id', name: 'Full SDLC (copy)', isDefault: false });
    vi.mocked(api.createWorkflow).mockImplementation(async () => {
      vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord(), copy] });
      return { workflow: copy };
    });
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await user.click(await screen.findByRole('button', { name: 'Clone workflow' }));
    const dialog = screen.getByRole('dialog', { name: 'Clone workflow' });
    expect(within(dialog).getByLabelText('Workflow name')).toHaveValue('Full SDLC (copy)');
    await user.click(within(dialog).getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledWith({ name: 'Full SDLC (copy)', cloneFrom: 'wf-default' }));
    expect(await screen.findByRole('img', { name: 'Workflow graph for Full SDLC (copy)' })).toBeInTheDocument();
  });

  it('keeps a failed creation open with its name and error', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createWorkflow).mockRejectedValue(new Error('Could not create workflow'));
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await user.click(await screen.findByRole('button', { name: 'New workflow' }));
    const dialog = screen.getByRole('dialog', { name: 'New workflow' });
    await user.type(within(dialog).getByLabelText('Workflow name'), 'Retry me');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not create workflow');
    expect(within(dialog).getByLabelText('Workflow name')).toHaveValue('Retry me');
  });

  it('lets new steps become agent steps or end steps', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await user.click(await screen.findByRole('button', { name: 'Add step' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Step type' }), 'agent');
    expect(screen.getByLabelText('Engine')).toHaveValue('claude');
    expect(screen.getByText('Agent steps need a prompt')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Step type' }), 'end');
    expect(screen.queryByLabelText('Engine')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('warns about pinned tasks before deleting a workflow without affecting their snapshot', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord(), workflowRecord(FULL_SDLC_WORKFLOW, { id: 'wf-copy', name: 'Copy', isDefault: false })] });
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await user.click(await screen.findByRole('button', { name: 'Delete workflow Full SDLC' }));
    expect(screen.getByRole('dialog', { name: 'Delete workflow?' })).toHaveTextContent("Deleting it won't affect pinned tasks");
    await user.click(screen.getByRole('button', { name: /^Delete workflow$/ }));
    await waitFor(() => expect(api.deleteWorkflow).toHaveBeenCalledWith('wf-default'));
  });
});
