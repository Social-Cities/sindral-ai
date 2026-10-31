import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMobileWorkflow } from '@sindral/shared';
import { renderWithProviders } from '@/test/utils';
import { makeTaskWithRelations } from '@/test/fixtures';
import { PlanTab } from './PlanTab';

describe('mobile plan review', () => {
  it('shows both plans and requests feedback on the selected plan', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    const onApprove = vi.fn();
    const task = makeTaskWithRelations({
      state: 'plan-review', currentStepId: 'plan-review', pinnedWorkflow: createMobileWorkflow(), plan: '# Implementation\nUse existing auth.',
      bddPlan: { kind: 'bdd-plan', summary: 'Login', plan: '# Behavior tests\nLogin coverage.', scenarios: [{ id: 'BDD-login', given: 'Signed out', when: 'Valid login submitted', then: 'Session established' }] },
    });
    renderWithProviders(<PlanTab task={task} canApprove approving={false} onApprove={onApprove} onFeedback={onFeedback} />);
    await user.click(screen.getByRole('tab', { name: 'BDD test plan' }));
    expect(screen.getByText('BDD-login')).toBeInTheDocument();
    expect(screen.getByText('Session established')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Feedback for'), 'bdd');
    await user.type(screen.getByLabelText('Plan feedback'), 'Cover expired sessions');
    await user.click(screen.getByRole('button', { name: 'Request plan changes' }));
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('Cover expired sessions', 'bdd'));
    await user.click(screen.getByRole('tab', { name: 'Implementation plan' }));
    expect(screen.getByText('Use existing auth.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve Both Plans' }));
    expect(onApprove).toHaveBeenCalledOnce();
  });
  it('prevents approval without a BDD plan', () => {
    renderWithProviders(<PlanTab task={makeTaskWithRelations({ pinnedWorkflow: createMobileWorkflow(), plan: '# Implementation' })} canApprove approving={false} onApprove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve Both Plans' })).toBeDisabled();
  });
});
