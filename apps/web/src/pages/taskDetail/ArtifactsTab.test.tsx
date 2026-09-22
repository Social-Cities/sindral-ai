import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeTaskWithRelations } from '@/test/fixtures';
import { ArtifactsTab } from './ArtifactsTab';

describe('ArtifactsTab', () => {
  it('previews small inline artifacts', () => {
    render(
      <ArtifactsTab
        task={makeTaskWithRelations({
          artifacts: [
            {
              id: 'artifact-1', taskId: 'task-1', jobId: null, name: 'report.md', contentType: 'text/markdown',
              content: '# Ready', byteSize: 7, downloadUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download artifact' })).not.toBeInTheDocument();
  });

  it('offers the owner-authorized URL for stored artifacts without rendering content', () => {
    render(
      <ArtifactsTab
        task={makeTaskWithRelations({
          artifacts: [
            {
              id: 'artifact-2', taskId: 'task-1', jobId: null, name: 'research.txt', contentType: 'text/plain',
              content: null, byteSize: 70_000, downloadUrl: 'http://storage.test/signed', createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/stored securely/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download artifact' })).toHaveAttribute('href', 'http://storage.test/signed');
    expect(screen.getByText('68 KiB')).toBeInTheDocument();
  });
});
