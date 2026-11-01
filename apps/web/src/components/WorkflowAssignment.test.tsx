import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FULL_SDLC_WORKFLOW } from '@sindral/shared';
import * as api from '@/lib/api';
import { makeTaskWithRelations, workflowRecord } from '@/test/fixtures';
import { renderWithProviders } from '@/test/utils';
import { WorkflowAssignment } from './WorkflowAssignment';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof api>(), previewTaskWorkflowAssignment: vi.fn(), assignTaskWorkflow: vi.fn(),
}));
const target = workflowRecord(FULL_SDLC_WORKFLOW, { id: 'target', name: 'Target workflow', isDefault: false });
function setup(state = 'failure') {
  const task = makeTaskWithRelations({ id: 'move-me', state, version: 8, pinnedWorkflow: FULL_SDLC_WORKFLOW });
  return renderWithProviders(<WorkflowAssignment task={task} workflows={[target]} />);
}
beforeEach(() => {
  vi.mocked(api.assignTaskWorkflow).mockReset();
  vi.mocked(api.previewTaskWorkflowAssignment).mockReset();
  vi.mocked(api.previewTaskWorkflowAssignment).mockImplementation(async (_id, input) => ({
    workflow: target, step: target.steps.find((step) => step.id === (input.stepId ?? 'todo'))!, expectedVersion: 8,
    warnings: input.stepId === 'implement' ? [{ code: 'missing-plan', message: 'Implementation plan is missing.' }] : [],
  }));
});

describe('WorkflowAssignment', () => {
  it('requires acknowledgement for missing inputs before running the selected agent', async () => {
    const user = userEvent.setup();
    vi.mocked(api.assignTaskWorkflow).mockResolvedValue({ task: makeTaskWithRelations({ state: 'implement', currentStepId: 'implement', workflowId: target.id, pinnedWorkflow: target }) });
    setup();
    await user.click(screen.getByRole('button', { name: 'Change workflow' }));
    await user.selectOptions(await screen.findByLabelText('Destination step'), 'implement');
    expect(await screen.findByText('Implementation plan is missing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move and run agent' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Move and run agent' }));
    await waitFor(() => expect(api.assignTaskWorkflow).toHaveBeenCalledWith('move-me', { workflowId: target.id, stepId: 'implement', expectedVersion: 8, acknowledgeWarnings: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('waits at a human step and does not present agent warnings', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Change workflow' }));
    await user.selectOptions(await screen.findByLabelText('Destination step'), 'plan-review');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move to step' })).toBeEnabled());
    expect(screen.getByText('The task will wait at this step until you take an action.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Destination step')).queryByRole('option', { name: /Done/ })).not.toBeInTheDocument();
  });

  it('keeps the destination and displays an error when running work prevents the move', async () => {
    const user = userEvent.setup();
    vi.mocked(api.assignTaskWorkflow).mockRejectedValue(new Error('Stop the running agent first.'));
    setup();
    await user.click(screen.getByRole('button', { name: 'Change workflow' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move to step' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Move to step' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop the running agent first.');
    expect(screen.getByLabelText('Destination workflow')).toHaveValue(target.id);
  });

  it('blocks a move when prerequisite preview fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.previewTaskWorkflowAssignment).mockRejectedValue(new Error('Workflow no longer exists'));
    setup();
    await user.click(screen.getByRole('button', { name: 'Change workflow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Workflow no longer exists');
    expect(screen.getByRole('button', { name: 'Move to step' })).toBeDisabled();
  });

  it('keeps closed tasks closed', () => {
    setup('done');
    expect(screen.getByRole('button', { name: 'Change workflow' })).toBeDisabled();
  });
});
