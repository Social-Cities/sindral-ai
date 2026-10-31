import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { mobileTaskPlatformOptions, type AppPlatform, type DesignResult, type TaskWithRelations, type Workflow } from '@sindral/shared';
import { Button } from '@/components/Button';
import { Markdown } from '@/components/Markdown';
import { Modal } from '@/components/Modal';
import { ExternalLink } from '@/components/ExternalLink';
import { TaskPlatformSelector } from '@/components/TaskPlatformSelector';
import { useProjects } from '@/hooks/useProjects';
import { useWorkflows } from '@/hooks/useWorkflows';
import { queryKeys } from '@/hooks/queryKeys';
import { API_BASE, approveDesign, createTask, getDesignRevision, getTaskDesign } from '@/lib/api';
import { ChatTab } from './ChatTab';

interface Props {
  task: TaskWithRelations; workflow: Workflow | null; userInitial: string;
  onSend: (content: string) => void; sending: boolean; error?: string | null; agentActive: boolean;
}

function downloadBundle(result: DesignResult, revisionId: string, approvedAt: string | null) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ revisionId, approvedAt, ...result }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `design-${revisionId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DesignTab({ task, workflow, userInitial, onSend, sending, error, agentActive }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const overviewKey = [...queryKeys.task(task.id), 'design'];
  const overview = useQuery({ queryKey: overviewKey, queryFn: () => getTaskDesign(task.id), refetchInterval: agentActive ? 5000 : 240_000 });
  const [selectedId, setSelectedId] = useState('');
  const [screen, setScreen] = useState(0);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [view, setView] = useState<'preview' | 'specification' | 'files'>('preview');
  const [mobilePanel, setMobilePanel] = useState<'design' | 'chat'>('design');
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [title, setTitle] = useState(`Implement ${task.title}`);
  const [scope, setScope] = useState('Implement the approved screens and flows, including responsive behavior and the specified interaction states.');
  const [repos, setRepos] = useState(task.repos.join(', '));
  const [projectId, setProjectId] = useState(task.projectId ?? '');
  const [workflowId, setWorkflowId] = useState('');
  const [platforms, setPlatforms] = useState<AppPlatform[] | null>(null);
  const handoffKey = useRef(crypto.randomUUID());
  const projects = useProjects();
  const workflows = useWorkflows();
  const implementationWorkflows = (workflows.data ?? []).filter((item) => item.steps.some((step) => ['implementation', 'pr', 'review-slice'].includes(step.output ?? '')));
  const project = projects.data?.find((item) => item.id === projectId);
  const defaultWorkflow = (project?.projectType === 'mobile-app' ? implementationWorkflows.find((item) => item.mobilePlatforms) : null) ?? implementationWorkflows[0];
  const selectedWorkflow = implementationWorkflows.find((item) => item.id === workflowId) ?? defaultWorkflow;
  const mobile = Boolean(selectedWorkflow?.mobilePlatforms);
  const selectedPlatforms = platforms ?? (project?.projectType === 'mobile-app' ? project.platforms : selectedWorkflow?.mobilePlatforms ?? []);
  useEffect(() => { setPlatforms(null); }, [projectId, workflowId]);
  const revisions = overview.data?.revisions ?? [];
  const selected = revisions.find((revision) => revision.id === selectedId) ?? revisions.at(-1);
  const revision = useQuery({ queryKey: [...overviewKey, selected?.id ?? ''], queryFn: () => getDesignRevision(task.id, selected!.id), enabled: Boolean(selected), refetchInterval: 240_000 });
  const input = overview.data?.input;
  const result = revision.data?.revision.result ?? input?.result;
  const revisionId = selected?.id ?? input?.revisionId;
  useEffect(() => { handoffKey.current = crypto.randomUUID(); }, [title, scope, repos, projectId, workflowId, platforms, revisionId]);
  const approvedAt = selected ? selected.approvedAt : input?.approvedAt ?? null;
  const previewUrls = selected ? revision.data?.previewUrls : overview.data?.inputPreviewUrls;
  const isInput = Boolean(input && !selected);
  useEffect(() => { setScreen(0); }, [selected?.id]);
  const approve = useMutation({
    mutationFn: () => approveDesign(task.id, selected!.id, task.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
  });
  const handoff = useMutation({
    mutationFn: () => createTask({
      title, description: `${scope}\n\nApproved design revision: ${revisionId}\n\n${result?.specification ?? ''}`.slice(0, 100_000),
      repos: repos.split(/[,\s]+/).filter(Boolean), workflowId: selectedWorkflow?.id,
      ...(mobile ? { platforms: selectedPlatforms } : {}),
      ...(projectId ? { projectId } : {}), designHandoff: { revisionId: revisionId!, idempotencyKey: handoffKey.current },
    }),
    onSuccess: ({ task: created }) => { void qc.invalidateQueries({ queryKey: queryKeys.tasks }); navigate(`/tasks/${created.id}`); },
  });
  const inputClass = 'w-full rounded border border-border bg-input px-3 py-2 text-sm text-foreground';

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {!isInput && <div className="flex shrink-0 gap-2 border-b border-border p-2 lg:hidden" role="group" aria-label="Design workspace panel">
        <button type="button" aria-pressed={mobilePanel === 'design'} onClick={() => setMobilePanel('design')} className="rounded px-3 py-1 text-xs">Design</button>
        <button type="button" aria-pressed={mobilePanel === 'chat'} onClick={() => setMobilePanel('chat')} className="rounded px-3 py-1 text-xs">Conversation</button>
      </div>}
      <div className={`${mobilePanel === 'chat' && !isInput ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-1 flex-col`}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          {selected ? <select aria-label="Design revision" value={selected.id} onChange={(event) => { setSelectedId(event.target.value); approve.reset(); }} className="max-w-64 rounded border border-border bg-input px-2 py-1.5 text-xs">
            {revisions.map((item, index) => <option key={item.id} value={item.id}>Revision {index + 1}{item.approvedAt ? ' · Approved' : ''}</option>)}
          </select> : <span className="text-sm font-medium">{isInput ? 'Approved design input' : 'Design workspace'}</span>}
          {approvedAt && <span className="text-xs text-emerald-400">Approved</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            {result?.designUrl && <ExternalLink href={result.designUrl} className="px-2 py-1 text-xs text-accent">Open in Claude ↗</ExternalLink>}
            {result && revisionId && <Button variant="subtle" onClick={() => downloadBundle(result, revisionId, approvedAt)}>Download handoff</Button>}
            {selected && !approvedAt && <Button variant="success" disabled={task.state !== 'design-review' || agentActive} loading={approve.isPending} onClick={() => approve.mutate()}>Approve revision</Button>}
            {selected && approvedAt && <Button onClick={() => setHandoffOpen(true)}>Create implementation task</Button>}
          </div>
        </div>
        {(approve.error || overview.error || revision.error) && <p role="alert" className="p-3 text-sm text-destructive">{(approve.error ?? overview.error ?? revision.error)?.message}</p>}
        {result ? <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <select aria-label="Design screen" value={screen} onChange={(event) => setScreen(Number(event.target.value))} className="max-w-64 rounded border border-border bg-input px-2 py-1.5 text-xs">
              {result.screens.map((item, index) => <option key={item.path} value={index}>{item.name}</option>)}
            </select>
            <div role="group" aria-label="Design view" className="flex gap-1">
              {(['preview', 'specification', 'files'] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)} className={`rounded px-2 py-1 text-xs capitalize ${view === item ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>{item}</button>)}
            </div>
            {view === 'preview' && <div role="group" aria-label="Preview size" className="ml-auto flex gap-1">
              {(['desktop', 'mobile'] as const).map((item) => <button key={item} type="button" aria-pressed={width === item} onClick={() => setWidth(item)} className={`rounded px-2 py-1 text-xs capitalize ${width === item ? 'bg-secondary' : 'text-muted-foreground'}`}>{item}</button>)}
            </div>}
          </div>
          <div className="min-h-64 flex-1 overflow-auto bg-muted p-3">
            {view === 'preview' && previewUrls?.[screen] && <iframe title={`Design preview: ${result.screens[screen]?.name ?? 'Screen'}`} src={`${API_BASE}${previewUrls[screen]}`} sandbox="allow-scripts" referrerPolicy="no-referrer" className="mx-auto h-full min-h-96 border border-border bg-white" style={{ width: width === 'mobile' ? 390 : '100%', maxWidth: '100%' }} />}
            {view === 'specification' && <Markdown>{result.specification}</Markdown>}
            {view === 'files' && <ul className="space-y-2 text-xs font-mono">{result.files.map((file) => <li key={file.path} className="rounded border border-border bg-card p-3"><span className="break-all">{file.path}</span><span className="ml-3 text-muted-foreground">{file.contentType}</span><p className="mt-1 break-all text-[10px] text-muted-foreground">SHA-256 {file.sha256}</p></li>)}</ul>}
          </div>
          <div className="border-t border-border p-3 text-xs text-muted-foreground">
            <p>{isInput ? 'This task uses a frozen copy of the approved design. Later design changes do not change this input.' : selected?.summary}</p>
            {overview.data?.checkpointAt && <p className="mt-1">Conversation and files saved · {new Date(overview.data.checkpointAt).toLocaleString()}</p>}
          </div>
        </> : <div className="flex min-h-64 flex-1 items-center justify-center p-8 text-center"><div><h2 className="text-lg font-medium">{agentActive ? 'Claude is working on your design' : 'Your app starts with a conversation'}</h2><p className="mt-2 max-w-md text-sm text-muted-foreground">{overview.isLoading ? 'Loading designs…' : agentActive ? 'You can send more feedback while generation runs. It will be used in the next turn.' : 'Describe the app, its users, and the screens you need. Start designing from the task actions, then review the result here.'}</p>{task.lastError && <p role="alert" className="mt-4 max-w-lg text-sm text-destructive">{task.lastError}</p>}</div></div>}
      </div>
      {!isInput && <div className={`${mobilePanel === 'design' ? 'hidden lg:block' : 'block'} min-h-0 flex-1 lg:h-full lg:w-96 lg:flex-none lg:border-l lg:border-border`}><ChatTab task={task} workflow={workflow} userInitial={userInitial} onSend={onSend} sending={sending} error={error} /></div>}
      <Modal open={handoffOpen} onClose={() => { if (!handoff.isPending) setHandoffOpen(false); }} title="Create implementation task">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">The task receives this approved revision, source files, assets, and specification as a permanent snapshot.</p>
          <label className="block space-y-1 text-xs">Title<input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="block space-y-1 text-xs">Implementation scope<textarea className={inputClass} rows={3} value={scope} onChange={(event) => setScope(event.target.value)} /></label>
          <label className="block space-y-1 text-xs">Project<select className={inputClass} value={projectId} onChange={(event) => { setProjectId(event.target.value); const project = projects.data?.find((item) => item.id === event.target.value); if (project) setRepos(project.repositories.map((item) => item.repository).join(', ')); }}><option value="">No project</option>{projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="block space-y-1 text-xs">Repositories<input className={inputClass} placeholder="owner/app, owner/api" value={repos} onChange={(event) => setRepos(event.target.value)} /></label>
          <label className="block space-y-1 text-xs">Workflow<select className={inputClass} value={selectedWorkflow?.id || ''} onChange={(event) => setWorkflowId(event.target.value)}>{implementationWorkflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {mobile && <TaskPlatformSelector value={selectedPlatforms} available={mobileTaskPlatformOptions(selectedWorkflow)} onChange={setPlatforms} />}
          {handoff.error && <p role="alert" className="text-sm text-destructive">{handoff.error.message}</p>}
          <Button disabled={!title.trim() || !repos.trim() || !implementationWorkflows.length || (mobile && !selectedPlatforms.length)} loading={handoff.isPending} onClick={() => handoff.mutate()}>Create task</Button>
        </div>
      </Modal>
    </div>
  );
}
