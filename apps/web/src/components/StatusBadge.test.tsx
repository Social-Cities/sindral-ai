import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders the label and a pulsing dot for active agent states', () => {
    render(<StatusBadge state="planning" />);
    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.getByTestId('status-dot')).toHaveClass('animate-pulse');
    expect(screen.getByTestId('status-badge')).toHaveStyle({ color: '#fbbf24' });
  });

  it('does not pulse for human-wait states', () => {
    render(<StatusBadge state="plan-review" />);
    expect(screen.getByText('Plan Review')).toBeInTheDocument();
    expect(screen.getByTestId('status-dot')).not.toHaveClass('animate-pulse');
  });

  it('falls back to the step label and agent styling for custom states', () => {
    render(<StatusBadge state="security-scan" step={{ type: 'agent', label: 'Security Scan' }} />);
    expect(screen.getByText('Security Scan')).toBeInTheDocument();
    expect(screen.getByTestId('status-dot')).toHaveClass('animate-pulse');
  });

  it('humanizes unknown states without a step', () => {
    render(<StatusBadge state="legal-review" />);
    expect(screen.getByText('Legal Review')).toBeInTheDocument();
  });
});
