import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
