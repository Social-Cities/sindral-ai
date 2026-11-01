import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TERMINAL_STATES, type TaskWithRelations, type WorkflowRecord } from '@sindral/shared';
import { useAssignTaskWorkflow } from '@/hooks/useTasks';
import { previewTaskWorkflowAssignment } from '@/lib/api';
import { Button } from './Button';
import { Select } from './Input';
import { Modal } from './Modal';

interface Props {
  task: TaskWithRelations;
  workflows: WorkflowRecord[];
  disabled?: boolean;
}

export function WorkflowAssignment({ task, workflows, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <span className="text-xs text-muted-foreground">Workflow: {task.pinnedWorkflow?.name ?? workflows.find((item) => item.id === task.workflowId)?.name ?? 'Unassigned'}</span>
        <Button variant="ghost" size="xs" onClick={() => setOpen(true)} disabled={disabled || TERMINAL_STATES.has(task.state) || !workflows.length}>Change workflow</Button>
      </div>
      {open && <AssignmentDialog task={task} workflows={workflows} onClose={close} />}
    </>
  );
}

function AssignmentDialog({ task, workflows, onClose }: Props & { onClose: () => void }) {
  const initial = workflows.find((item) => item.id === task.workflowId) ?? workflows[0]!;
  const [workflowId, setWorkflowId] = useState(initial.id);
  const [stepId, setStepId] = useState('');
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const assignment = useAssignTaskWorkflow(task.id);
  const saved = workflows.find((item) => item.id === workflowId);
  const preview = useQuery({
    queryKey: ['workflow-assignment-preview', task.id, task.version, workflowId, saved?.updatedAt, stepId],
    queryFn: () => previewTaskWorkflowAssignment(task.id, { workflowId, ...(stepId ? { stepId } : {}) }),
    retry: false,
  });
  const data = preview.data;
  const acknowledgementKey = data ? JSON.stringify(data) : '';
  const warningsAccepted = !data?.warnings.length || acknowledged === acknowledgementKey;
  const canMove = Boolean(data && !preview.isFetching && !preview.isError && warningsAccepted && !assignment.isPending);
  const close = useCallback(() => { if (!assignment.isPending) onClose(); }, [assignment.isPending, onClose]);

  async function move() {
    if (!data || !canMove) return;
    try {
      await assignment.mutateAsync({ workflowId: data.workflow.id, stepId: data.step.id, expectedVersion: data.expectedVersion, acknowledgeWarnings: Boolean(data.warnings.length && warningsAccepted) });
      onClose();
    } catch {
      // Preserve the selection and show the mutation's error so the user can retry.
    }
  }

  return (
    <Modal open title="Change workflow" onClose={close} footer={
      <>
        <Button variant="subtle" className="flex-1" onClick={close} disabled={assignment.isPending}>Cancel</Button>
        <Button className="flex-1" onClick={move} disabled={!canMove} loading={assignment.isPending}>{data?.step.type === 'agent' ? 'Move and run agent' : 'Move to step'}</Button>
      </>
    }>
      <div className="space-y-4">
        <Select label="Destination workflow" value={workflowId} disabled={assignment.isPending} onChange={(event) => { setWorkflowId(event.target.value); setStepId(''); setAcknowledged(null); assignment.reset(); }}>
          {workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        {data && <Select label="Destination step" value={data.step.id} disabled={assignment.isPending} onChange={(event) => { setStepId(event.target.value); setAcknowledged(null); assignment.reset(); }}>
          {data.workflow.steps.filter((step) => step.type !== 'end').map((step) => <option key={step.id} value={step.id}>{step.label} ({step.type === 'agent' ? 'agent' : 'human'})</option>)}
        </Select>}
        {preview.isFetching && <p role="status">Checking the destination and prerequisites…</p>}
        {data && <p>{data.step.type === 'agent' ? `${data.step.label} will run immediately using ${data.step.engine ?? 'the configured worker'}${data.step.model ? ` / ${data.step.model}` : ''}.` : 'The task will wait at this step until you take an action.'}</p>}
        <p>Existing plans, messages, artifacts and pull requests are kept. Earlier checkpoints in the destination workflow are skipped.</p>
        {data?.warnings.length ? <div className="rounded border border-border p-3 space-y-2">
          <p className="font-semibold">Missing prerequisites</p>
          <ul className="list-disc pl-4 space-y-1">{data.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={acknowledged === acknowledgementKey} disabled={assignment.isPending} onChange={(event) => setAcknowledged(event.target.checked ? acknowledgementKey : null)} />
            I understand these prerequisites are missing and want to run this step anyway.
          </label>
        </div> : null}
        <p className="text-muted-foreground">Stop any running agent and wait for it to finish before moving. Queued work for this task will be replaced.</p>
        {preview.error && <p role="alert" className="text-[#f87171]">{preview.error.message}</p>}
        {assignment.error && <p role="alert" className="text-[#f87171]">{assignment.error.message}</p>}
      </div>
    </Modal>
  );
}
