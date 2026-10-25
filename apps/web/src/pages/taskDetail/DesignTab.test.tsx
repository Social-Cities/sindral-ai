import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DESIGN_WORKFLOW, type DesignResult, type DesignRevision } from '@sindral/shared';
import * as api from '@/lib/api';
import { renderWithProviders } from '@/test/utils';
import { makeTaskWithRelations, workflowRecord } from '@/test/fixtures';
import { DesignTab } from './DesignTab';

vi.mock('@/lib/api', async (original) => ({ ...await original<typeof api>(), getTaskDesign: vi.fn(), getDesignRevision: vi.fn(), approveDesign: vi.fn(), listProjects: vi.fn(), listWorkflows: vi.fn() }));

const result: DesignResult = {
  kind: 'design', summary: 'Dashboard ready', designUrl: null, specification: '# Dashboard specification\nUse the blue button.', questions: [],
  screens: [{ name: 'Dashboard', path: 'index.html' }], files: [{ path: 'index.html', contentType: 'text/html', encoding: 'utf8', content: '<h1>Dashboard</h1>', sha256: 'a'.repeat(64) }],
};
const revision: DesignRevision = { id: 'revision-1', taskId: 'task-1', jobId: 'job-1', result, createdAt: '2026-10-25T12:00:00Z', approvedAt: null };
const task = makeTaskWithRelations({ id: 'task-1', state: 'design-review', currentStepId: 'design-review', pinnedWorkflow: DESIGN_WORKFLOW, version: 3 });

function setup(input = false) {
  vi.mocked(api.getTaskDesign).mockResolvedValue({ revisions: input ? [] : [{ ...revision, summary: result.summary, screens: result.screens, designUrl: result.designUrl }], checkpointAt: '2026-10-25T12:00:00Z',
    input: input ? { sourceTaskId: 'deleted-source', revisionId: revision.id, approvedAt: '2026-10-25T12:00:00Z', result } : null, inputPreviewUrls: ['/api/design-previews/input?token=test'] });
  return renderWithProviders(<DesignTab task={task} workflow={DESIGN_WORKFLOW} userInitial="L" onSend={vi.fn()} sending={false} agentActive={false} />);
}

describe('DesignTab', () => {
  beforeEach(() => {
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [] });
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflowRecord()] });
    vi.mocked(api.getDesignRevision).mockResolvedValue({ revision, previewUrls: ['/api/design-previews/task-1?token=test'] });
    vi.mocked(api.approveDesign).mockResolvedValue({ revision: { ...revision, approvedAt: '2026-10-25T12:00:00Z' } });
  });

  it('shows an isolated preview beside chat and approves exactly the selected revision', async () => {
    const user = userEvent.setup(); setup();
    const preview = await screen.findByTitle('Design preview: Dashboard');
    expect(preview).toHaveAttribute('sandbox', 'allow-scripts');
    expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.queryByRole('link', { name: /Open in Claude/ })).not.toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve revision' }));
    expect(api.approveDesign).toHaveBeenCalledWith(task.id, revision.id, 3);
    await user.click(screen.getByRole('button', { name: 'specification' }));
    expect(screen.getByRole('heading', { name: 'Dashboard specification' })).toBeInTheDocument();
  });

  it('keeps external editor links for earlier hosted revisions', async () => {
    vi.mocked(api.getDesignRevision).mockResolvedValue({ revision: { ...revision, result: { ...result, designUrl: 'https://claude.ai/code/artifact/existing' } }, previewUrls: ['/api/design-previews/task-1?token=test'] });
    setup();
    expect(await screen.findByRole('link', { name: /Open in Claude/ })).toHaveAttribute('href', 'https://claude.ai/code/artifact/existing');
  });

  it('offers a frozen implementation input even after the original design was deleted', async () => {
    setup(true);
    expect(await screen.findByTitle('Design preview: Dashboard')).toHaveAttribute('src', '/api/design-previews/input?token=test');
    expect(screen.getByText(/frozen copy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve revision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });
});
