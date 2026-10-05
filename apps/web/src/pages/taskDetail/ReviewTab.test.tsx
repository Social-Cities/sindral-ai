import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { makeTaskWithRelations } from '@/test/fixtures';
import { ReviewTab } from './ReviewTab';

describe('ReviewTab', () => {
  it('renders review slices as a commit guide', () => {
    render(
      <ReviewTab
        task={makeTaskWithRelations({
          artifacts: [
            {
              id: 'slices',
              taskId: 'task-1',
              jobId: null,
              name: 'review-slices.json',
              contentType: 'application/json',
              content: JSON.stringify({
                summary: 'Review in this order.',
                slices: [
                  {
                    repository: 'acme/app',
                    commit: 'abcdef1',
                    title: 'Add the API contract',
                    summary: 'Introduces the shared types first.',
                    files: ['packages/shared/src/types.ts'],
                    reviewNotes: 'Start here before reading the UI commit.',
                  },
                ],
              }),
              byteSize: 260,
              downloadUrl: null,
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        })}
      />,
    );

    expect(screen.getAllByText('Commit guide').length).toBeGreaterThan(0);
    expect(screen.getByText('Review in this order.')).toBeInTheDocument();
    expect(screen.getByText('1. Add the API contract')).toBeInTheDocument();
    expect(screen.getByText(/Start here before reading the UI commit/)).toBeInTheDocument();
  });

  it('renders diff explanation and adversarial review as separate review documents', async () => {
    const user = userEvent.setup();
    render(
      <ReviewTab
        task={makeTaskWithRelations({
          artifacts: [
            {
              id: 'old-review',
              taskId: 'task-1',
              jobId: null,
              name: 'adversarial-review.md',
              contentType: 'text/markdown',
              content: '## Diff explanation\nOld explanation.',
              byteSize: 31,
              downloadUrl: null,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'new-diff',
              taskId: 'task-1',
              jobId: null,
              name: 'diff-explanation.md',
              contentType: 'text/markdown',
              content: 'Changed the task detail view.',
              byteSize: 30,
              downloadUrl: null,
              createdAt: '2026-01-02T00:00:00.000Z',
            },
            {
              id: 'new-review',
              taskId: 'task-1',
              jobId: null,
              name: 'adversarial-review.md',
              contentType: 'text/markdown',
              content: '## Findings ordered by severity\nNo material findings.',
              byteSize: 51,
              downloadUrl: null,
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole('list', { name: 'Reviews' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Diff explanation/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Changed the task detail view.')).toBeInTheDocument();
    expect(screen.queryByText('No material findings.')).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Adversarial review/ })[0]!);
    expect(screen.getByText('No material findings.')).toBeInTheDocument();
    expect(screen.queryByText('Changed the task detail view.')).not.toBeInTheDocument();
    expect(screen.queryByText('Old explanation.')).not.toBeInTheDocument();
  });

  it('splits older combined review reports into two review documents', async () => {
    const user = userEvent.setup();
    render(
      <ReviewTab
        task={makeTaskWithRelations({
          artifacts: [
            {
              id: 'combined-review',
              taskId: 'task-1',
              jobId: null,
              name: 'adversarial-review.md',
              contentType: 'text/markdown',
              content: '## Diff explanation\nChanged the task detail view.\n\n## Findings ordered by severity\nNo material findings.',
              byteSize: 96,
              downloadUrl: null,
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Changed the task detail view.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Adversarial review/ }));
    expect(screen.getByText('No material findings.')).toBeInTheDocument();
    expect(screen.queryByText('Changed the task detail view.')).not.toBeInTheDocument();
  });

  it('offers the owner-authorized URL for stored reviews without rendering content', () => {
    render(
      <ReviewTab
        task={makeTaskWithRelations({
          artifacts: [
            {
              id: 'stored-review',
              taskId: 'task-1',
              jobId: null,
              name: 'adversarial-review.md',
              contentType: 'text/markdown',
              content: null,
              byteSize: 70_000,
              downloadUrl: 'http://storage.test/review',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/stored securely/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download review' })).toHaveAttribute('href', 'http://storage.test/review');
  });
});
