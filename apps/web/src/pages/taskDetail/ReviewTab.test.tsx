import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeTaskWithRelations } from '@/test/fixtures';
import { extractMarkdownSection, ReviewTab } from './ReviewTab';

describe('ReviewTab', () => {
  it('extracts the diff explanation section from a review report', () => {
    expect(
      extractMarkdownSection(
        '# Review\n\n## Diff explanation\nChanged `TaskDetail` to expose review output.\n\n### Assumptions\nThe report uses standard headings.\n\n## Findings ordered by severity\nNone.',
        'Diff explanation',
      ),
    ).toBe('Changed `TaskDetail` to expose review output.\n\n### Assumptions\nThe report uses standard headings.');
  });

  it('renders the latest diff explanation and full review', () => {
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
              id: 'new-review',
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

    expect(screen.getByRole('heading', { name: 'Diff explanation' })).toBeInTheDocument();
    expect(screen.getAllByText('Changed the task detail view.')).toHaveLength(2);
    expect(screen.getByText('Full review')).toBeInTheDocument();
    expect(screen.getByText('No material findings.')).toBeInTheDocument();
    expect(screen.queryByText('Old explanation.')).not.toBeInTheDocument();
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
