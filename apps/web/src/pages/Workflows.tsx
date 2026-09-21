import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UpdateWorkflowInput, Workflow, WorkflowEdge, WorkflowRecord, WorkflowStep } from '@sindral/shared';
import { validateWorkflow } from '@sindral/shared';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { PageLoader } from '@/components/Spinner';
import { StepConfigPanel } from '@/components/StepConfigPanel';
import { WorkflowCanvas } from '@/components/WorkflowCanvas';
import { useTasks } from '@/hooks/useTasks';
import { useCreateWorkflow, useDeleteWorkflow, useUpdateWorkflow, useWorkflows } from '@/hooks/useWorkflows';

/** Strip record-only fields so the draft matches the PUT body shape. */
export function toDraft(record: Workflow): Workflow {
  const draft: Workflow = {
    id: record.id,
    name: record.name,
    entryStepId: record.entryStepId,
    steps: record.steps.map((s) => ({ ...s })),
    edges: record.edges.map((e) => ({ ...e })),
  };
  if (record.description !== undefined) draft.description = record.description;
  if (record.troubleshootStep) draft.troubleshootStep = { ...record.troubleshootStep };
  return draft;
}

function toUpdateInput(draft: Workflow): UpdateWorkflowInput {
  const { id: _id, ...rest } = draft;
  return rest;
}

function sameWorkflow(a: Workflow, b: Workflow): boolean {
  return JSON.stringify(toDraft(a)) === JSON.stringify(toDraft(b));
}

function nextStepId(steps: WorkflowStep[]): string {
  let n = steps.length + 1;
  const ids = new Set(steps.map((s) => s.id));
  while (ids.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}

export function Workflows() {
  const workflowsQuery = useWorkflows();
  const tasksQuery = useTasks();
  const createWorkflow = useCreateWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();

  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  const [selectedWfId, setSelectedWfId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const selectedRecord: WorkflowRecord | null = useMemo(
    () => workflows.find((w) => w.id === selectedWfId) ?? workflows[0] ?? null,
    [workflows, selectedWfId],
  );

  // Load a fresh draft whenever a different workflow is selected or the record
  // changes on the server (e.g. after a save). Unsaved edits survive refetches
  // that return the same version.
  const loadedRef = useRef<{ id: string; updatedAt: string } | null>(null);
  useEffect(() => {
    if (!selectedRecord) {
      loadedRef.current = null;
      setDraft(null);
      return;
    }
    const loaded = loadedRef.current;
    if (loaded && loaded.id === selectedRecord.id && loaded.updatedAt === selectedRecord.updatedAt) return;
    loadedRef.current = { id: selectedRecord.id, updatedAt: selectedRecord.updatedAt };
    setDraft(toDraft(selectedRecord));
  }, [selectedRecord]);

  const issues = useMemo(() => (draft ? validateWorkflow(draft) : []), [draft]);
  const dirty = !!draft && !!selectedRecord && !sameWorkflow(draft, selectedRecord);
  const canSave = dirty && issues.length === 0 && !updateWorkflow.isPending;

  const taskCount = useCallback(
    (wfId: string) => tasks.filter((t) => (t.workflowId === wfId || t.pinnedWorkflow?.id === wfId) && t.state !== 'done').length,
    [tasks],
  );
  const pinnedCount = useCallback((wfId: string) => tasks.filter((t) => t.pinnedWorkflow?.id === wfId && t.state !== 'done').length, [tasks]);

  const save = useCallback(async () => {
    if (!draft || !canSave) return;
    setSaveError(null);
    try {
      await updateWorkflow.mutateAsync({ id: draft.id, input: toUpdateInput(draft) });
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save workflow');
    }
  }, [draft, canSave, updateWorkflow]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(t);
  }, [savedAt]);

  function selectWorkflow(id: string) {
    if (id === selectedRecord?.id) return;
    if (dirty && !window.confirm('Discard unsaved changes to this workflow?')) return;
    setSelectedWfId(id);
    setSelectedStepId(null);
    setSaveError(null);
    setSavedAt(null);
  }

  function patchDraft(patch: Partial<Workflow>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSavedAt(null);
  }

  function updateStep(stepId: string, patch: Partial<WorkflowStep>) {
    setDraft((d) => (d ? { ...d, steps: d.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) } : d));
    setSavedAt(null);
  }

  function addStep() {
    if (!draft) return;
    const id = nextStepId(draft.steps);
    const maxX = draft.steps.reduce((m, s) => Math.max(m, s.position?.x ?? 0), 0);
    const step: WorkflowStep = { id, type: 'human', label: 'New step', state: id, position: { x: maxX + 160, y: 150 } };
    patchDraft({ steps: [...draft.steps, step] });
    setSelectedStepId(id);
  }

  function deleteStep(stepId: string) {
    if (!draft) return;
    const steps = draft.steps.filter((s) => s.id !== stepId);
    const edges = draft.edges.filter((e) => e.from !== stepId && e.to !== stepId);
    const entryStepId = draft.entryStepId === stepId ? (steps.find((s) => s.type === 'human')?.id ?? steps[0]?.id ?? '') : draft.entryStepId;
    patchDraft({ steps, edges, entryStepId });
    if (selectedStepId === stepId) setSelectedStepId(null);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      const { workflow } = await createWorkflow.mutateAsync({ name, cloneFrom: selectedRecord?.id });
      setNewName('');
      setCreating(false);
      setSelectedWfId(workflow.id);
      setSelectedStepId(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not create workflow');
    }
  }

  function requestDelete(id: string) {
    if (pinnedCount(id) > 0 || taskCount(id) > 0) setConfirmDelete(id);
    else void confirmAndDelete(id);
  }

  async function confirmAndDelete(id: string) {
    try {
      await deleteWorkflow.mutateAsync(id);
      if (selectedRecord?.id === id) {
        setSelectedWfId(workflows.find((w) => w.id !== id)?.id ?? null);
        setSelectedStepId(null);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not delete workflow');
    } finally {
      setConfirmDelete(null);
    }
  }

  const selectedStep = draft?.steps.find((s) => s.id === selectedStepId) ?? null;
  const globalIssues = issues.filter((i) => !/^steps\[\d+\]\./.test(i.path) && !/^edges\[\d+\]/.test(i.path));

  if (workflowsQuery.isLoading) return <PageLoader label="Loading workflows…" />;

  return (
    <div className="h-full flex">
      {/* Workflows list sidebar */}
      <aside className="w-52 shrink-0 flex flex-col border-r border-border bg-muted">
        <div className="px-4 pt-4 pb-3 flex items-center justify-between border-b border-border">
          <span className="label-caps">Workflows</span>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setNewName('');
            }}
            className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors bg-secondary"
            title="New workflow"
            aria-label="New workflow"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {creating && (
          <div className="px-3 py-2.5 border-b border-border">
            <input
              autoFocus
              aria-label="Workflow name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="Workflow name..."
              className="w-full text-xs text-foreground px-2 py-1.5 rounded outline-none bg-input"
              style={{ border: '1px solid #818cf840' }}
            />
            <p className="text-[9px] text-muted-foreground mt-1">Clones “{selectedRecord?.name ?? 'Full SDLC'}”.</p>
            <div className="flex gap-1.5 mt-1.5">
              <Button size="xs" onClick={handleCreate} loading={createWorkflow.isPending} className="flex-1">
                Create
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setCreating(false)} className="flex-1">
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2">
          {workflows.map((wf) => {
            const active = wf.id === selectedRecord?.id;
            const count = taskCount(wf.id);
            const pins = pinnedCount(wf.id);
            return (
              <div key={wf.id} className="group relative">
                <button
                  type="button"
                  onClick={() => selectWorkflow(wf.id)}
                  aria-current={active ? 'true' : undefined}
                  className="w-full text-left"
                >
                  <div className={`mx-2 my-0.5 px-3 py-2.5 rounded-md transition-all border ${active ? 'bg-secondary border-border' : 'border-transparent'}`}>
                    <p className={`text-xs font-medium truncate transition-colors ${active ? 'text-foreground' : 'text-secondary-foreground group-hover:text-foreground'}`}>
                      {wf.name}
                      {active && dirty && <span className="text-accent"> •</span>}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] font-mono text-muted-foreground">{wf.steps.length} steps</span>
                      {count > 0 && (
                        <span className="text-[10px] font-mono px-1 rounded" style={{ background: '#7c3aed15', color: '#a78bfa' }}>
                          {count} active
                        </span>
                      )}
                      {pins > 0 && (
                        <span className="text-[10px]" title={`${pins} task(s) pinned to this version`}>
                          📌
                        </span>
                      )}
                      {wf.isDefault && <span className="text-[9px] font-mono text-muted-foreground">default</span>}
                    </div>
                  </div>
                </button>
                {workflows.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete(wf.id);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-red-400"
                    title="Delete workflow"
                    aria-label={`Delete workflow ${wf.name}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-border">
          <div className="space-y-1.5 text-[10px] font-mono text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span style={{ color: '#a78bfa' }}>◆</span> agent step
            </div>
            <div className="flex items-center gap-1.5">
              <span style={{ color: '#8b92a8' }}>◇</span> human checkpoint
            </div>
            <div className="flex items-center gap-1.5">
              <span style={{ color: '#34d399' }}>●</span> end
            </div>
          </div>
        </div>
      </aside>

      {/* Canvas */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {draft && selectedRecord ? (
          <>
            <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xs text-muted-foreground font-mono shrink-0">Workflow:</span>
                <input
                  aria-label="Workflow name"
                  value={draft.name}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                  className="text-sm font-medium text-foreground bg-transparent outline-none border-b border-transparent hover:border-border focus:border-accent/50 transition-colors pb-px min-w-0"
                />
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {pinnedCount(draft.id) > 0 && (
                  <span className="text-[10px] font-mono px-2 py-1 rounded flex items-center gap-1.5" style={{ background: '#34d39908', border: '1px solid #34d39920', color: '#34d399' }}>
                    📌 {pinnedCount(draft.id)} task{pinnedCount(draft.id) !== 1 ? 's' : ''} pinned to this version
                  </span>
                )}
                <Button variant="ghost" onClick={addStep}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  Add step
                </Button>
                <Button onClick={save} disabled={!canSave} loading={updateWorkflow.isPending} title="Cmd+S">
                  {savedAt ? 'Saved ✓' : 'Save'}
                </Button>
              </div>
            </div>

            {(globalIssues.length > 0 || saveError) && (
              <div className="shrink-0 px-5 py-2 border-b border-border bg-[#f8717108]" role="alert" data-testid="workflow-issues">
                {saveError && <p className="text-xs text-[#f87171]">{saveError}</p>}
                {globalIssues.map((i) => (
                  <p key={`${i.path}:${i.message}`} className="text-xs text-[#f87171]">
                    <span className="font-mono text-muted-foreground">{i.path}</span> — {i.message}
                  </p>
                ))}
              </div>
            )}
            {issues.length > 0 && globalIssues.length === 0 && (
              <div className="shrink-0 px-5 py-2 border-b border-border bg-[#f8717108]" role="alert" data-testid="workflow-issues">
                <p className="text-xs text-[#f87171]">
                  {issues.length} issue{issues.length === 1 ? '' : 's'} in step configuration — select the affected step to fix.
                </p>
              </div>
            )}

            <div className="flex-1 overflow-auto flex items-center justify-center p-6">
              <WorkflowCanvas
                workflow={draft}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
                onMoveStep={(stepId, position) => updateStep(stepId, { position })}
                onDeleteStep={deleteStep}
              />
            </div>
            {draft.description && <p className="shrink-0 px-5 py-2 text-[10px] text-muted-foreground border-t border-border">{draft.description}</p>}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Select a workflow to view</div>
        )}
      </div>

      {/* Step config panel */}
      <aside className="w-72 shrink-0 flex flex-col border-l border-border bg-muted">
        <div className="shrink-0 px-5 py-3 flex items-center justify-between border-b border-border">
          <span className="label-caps">{selectedStep ? 'Step config' : 'Select a step'}</span>
          {selectedStep && (
            <>
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{
                  background: selectedStep.type === 'agent' ? '#7c3aed15' : selectedStep.type === 'end' ? '#34d39915' : '#1c1c30',
                  color: selectedStep.type === 'agent' ? '#a78bfa' : selectedStep.type === 'end' ? '#34d399' : '#8b92a8',
                }}
              >
                {selectedStep.type}
              </span>
              <button type="button" onClick={() => setSelectedStepId(null)} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close step config">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {draft && selectedStep ? (
            <StepConfigPanel
              workflow={draft}
              step={selectedStep}
              issues={issues}
              onChange={(patch) => updateStep(selectedStep.id, patch)}
              onEdgesChange={(edges: WorkflowEdge[]) => patchDraft({ edges })}
              onSetEntry={(stepId) => patchDraft({ entryStepId: stepId })}
              onDelete={deleteStep}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="text-muted-foreground opacity-40" aria-hidden="true">
                <rect x="2" y="10" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <rect x="16" y="10" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
                <path d="M12 14h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <p className="text-xs text-muted-foreground">Click a node to configure it</p>
              <p className="text-[10px] text-muted-foreground">Drag nodes to rearrange · Cmd+S to save</p>
            </div>
          )}
        </div>
      </aside>

      <Modal
        open={confirmDelete !== null}
        title="Delete workflow?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="subtle" className="flex-1" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => confirmDelete && confirmAndDelete(confirmDelete)} loading={deleteWorkflow.isPending}>
              Delete workflow
            </Button>
          </>
        }
      >
        {confirmDelete && (
          <>
            {pinnedCount(confirmDelete)} active task{pinnedCount(confirmDelete) !== 1 ? 's are' : ' is'} pinned to this workflow&apos;s snapshot
            {taskCount(confirmDelete) > pinnedCount(confirmDelete) && ` and ${taskCount(confirmDelete) - pinnedCount(confirmDelete)} more reference it`}. Deleting it
            won&apos;t affect pinned tasks — they&apos;ll continue using their pinned copy. This action cannot be undone.
          </>
        )}
      </Modal>
    </div>
  );
}
