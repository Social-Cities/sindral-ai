import type { AgentEngine, AgentMode, Permission, StepOutputKind, ToolName, Workflow, WorkflowEdge, WorkflowStep, WorkflowValidationIssue } from '@sindral/shared';
import { ALL_OUTPUT_KINDS, ALL_PERMISSIONS, ALL_TOOLS, MODEL_OPTIONS } from '@sindral/shared';
import { Button } from './Button';
import { Input, Select, Textarea } from './Input';

const ENGINES: AgentEngine[] = ['claude', 'codex'];
const MODES: AgentMode[] = ['high', 'normal', 'low'];
const PROMPT_TOKENS = ['{{task_description}}', '{{plan}}', '{{feedback}}', '{{task_key}}', '{{task_title}}', '{{pr_url}}', '{{review}}', '{{error}}'];

interface StepConfigPanelProps {
  workflow: Workflow;
  step: WorkflowStep;
  issues: WorkflowValidationIssue[];
  onChange: (patch: Partial<WorkflowStep>) => void;
  onEdgesChange: (edges: WorkflowEdge[]) => void;
  onSetEntry: (stepId: string) => void;
  onDelete: (stepId: string) => void;
}

function Toggle({ active, onClick, children, tone }: { active: boolean; onClick: () => void; children: string; tone: 'violet' | 'green' }) {
  const palette =
    tone === 'violet'
      ? {
          bg: active ? 'color-mix(in srgb, var(--color-primary) 16%, transparent)' : 'var(--color-toggle-bg)',
          border: active ? 'color-mix(in srgb, var(--color-primary) 42%, transparent)' : 'var(--color-border)',
          color: active ? 'var(--color-node-agent-text)' : 'var(--color-toggle-muted)',
        }
      : {
          bg: active ? 'color-mix(in srgb, var(--color-success) 14%, transparent)' : 'var(--color-toggle-bg)',
          border: active ? 'color-mix(in srgb, var(--color-success) 36%, transparent)' : 'var(--color-border)',
          color: active ? 'var(--color-success)' : 'var(--color-toggle-muted)',
        };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onClick}
      className="px-2 py-0.5 rounded text-[10px] font-mono transition-all"
      style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color }}
    >
      {children}
    </button>
  );
}

export function StepConfigPanel({ workflow, step, issues, onChange, onEdgesChange, onSetEntry, onDelete }: StepConfigPanelProps) {
  const stepIndex = workflow.steps.findIndex((s) => s.id === step.id);
  const issueFor = (field: string) => issues.find((i) => i.path === `steps[${stepIndex}].${field}`)?.message;
  const stepIssues = issues.filter((i) => i.path === `steps.${step.id}`);
  const outgoing = workflow.edges.map((e, index) => ({ edge: e, index })).filter(({ edge }) => edge.from === step.id);
  const isEntry = workflow.entryStepId === step.id;
  const isAgent = step.type === 'agent';

  function updateEdge(index: number, patch: Partial<WorkflowEdge>) {
    onEdgesChange(workflow.edges.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }
  function removeEdge(index: number) {
    onEdgesChange(workflow.edges.filter((_e, i) => i !== index));
  }
  function addEdge() {
    const target = workflow.steps.find((s) => s.id !== step.id) ?? step;
    const usedEvents = new Set(outgoing.map(({ edge }) => edge.event));
    const defaultEvent = isAgent ? 'complete' : 'approve';
    let event = defaultEvent;
    let n = 2;
    while (usedEvents.has(event)) event = `${defaultEvent}-${n++}`;
    onEdgesChange([...workflow.edges, { from: step.id, to: target.id, event }]);
  }

  const toolsOn = new Set<ToolName>(step.tools ?? []);
  const permsOn = new Set<Permission>(step.permissions ?? []);
  const models = step.engine ? MODEL_OPTIONS[step.engine] : [];

  return (
    <div className="p-5 space-y-4">
      <div>
        <p className="label-caps">Type</p>
        <p className="text-xs text-secondary-foreground mt-1.5 leading-relaxed">
          {step.type === 'human' && 'Human checkpoint — workflow pauses until a user clicks an action or sends chat feedback.'}
          {step.type === 'agent' && 'Agent step — dispatched to a worker; emits "complete" when finished (or "reject" for a NO_GO verdict).'}
          {step.type === 'end' && 'End step — the task is marked done when it arrives here.'}
        </p>
        <p className="text-[10px] font-mono text-muted-foreground mt-1.5">id: {step.id}</p>
      </div>

      <Input label="Label" value={step.label} onChange={(e) => onChange({ label: e.target.value })} error={issueFor('label')} />

      {step.type !== 'end' && (
        <Input
          label="State"
          mono
          value={step.state}
          onChange={(e) => onChange({ state: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
          hint="Task state shown while on this step (lowercase, dashes)."
          error={issueFor('state')}
        />
      )}

      {step.type === 'human' && (
        <label className="flex items-center gap-2 text-xs text-secondary-foreground cursor-pointer">
          <input type="radio" name="entry-step" checked={isEntry} onChange={() => onSetEntry(step.id)} className="accent-[#7c3aed]" />
          Entry step (tasks start here)
        </label>
      )}

      {isAgent && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Select
              label="Engine"
              value={step.engine ?? ''}
              onChange={(e) => {
                const engine = e.target.value as AgentEngine;
                const first = MODEL_OPTIONS[engine]?.[0];
                onChange({ engine, model: first ?? step.model });
              }}
              error={issueFor('engine')}
            >
              <option value="" disabled>
                Select…
              </option>
              {ENGINES.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
            <Select label="Model" value={step.model ?? ''} onChange={(e) => onChange({ model: e.target.value })} error={issueFor('model')} disabled={!step.engine}>
              <option value="" disabled>
                Select…
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {step.model && !models.includes(step.model) && <option value={step.model}>{step.model}</option>}
            </Select>
            <Select label="Mode" value={step.mode ?? 'normal'} onChange={(e) => onChange({ mode: e.target.value as AgentMode })}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Select label="Output" value={step.output ?? ''} onChange={(e) => onChange({ output: e.target.value as StepOutputKind })} error={issueFor('output')}>
              <option value="" disabled>
                Select…
              </option>
              {ALL_OUTPUT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Textarea label="Prompt" mono rows={8} value={step.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} error={issueFor('prompt')} />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {PROMPT_TOKENS.map((t) => (
                <button
                  key={t}
                  type="button"
                  title="Append token to prompt"
                  onClick={() => onChange({ prompt: `${step.prompt ?? ''}${step.prompt?.endsWith('\n') || !step.prompt ? '' : '\n'}${t}` })}
                  className="text-[9px] font-mono px-1 py-0.5 rounded bg-secondary text-muted-foreground hover:text-accent transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="label-caps">Allowed tools</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ALL_TOOLS.map((tool) => (
                <Toggle
                  key={tool}
                  tone="violet"
                  active={toolsOn.has(tool)}
                  onClick={() => {
                    const next = new Set(toolsOn);
                    if (next.has(tool)) next.delete(tool);
                    else next.add(tool);
                    onChange({ tools: ALL_TOOLS.filter((t) => next.has(t)) });
                  }}
                >
                  {tool}
                </Toggle>
              ))}
            </div>
          </div>

          <div>
            <p className="label-caps">Permissions</p>
            <div className="mt-2 flex gap-1.5">
              {ALL_PERMISSIONS.map((perm) => (
                <Toggle
                  key={perm}
                  tone="green"
                  active={permsOn.has(perm)}
                  onClick={() => {
                    const next = new Set(permsOn);
                    if (next.has(perm)) next.delete(perm);
                    else next.add(perm);
                    onChange({ permissions: ALL_PERMISSIONS.filter((p) => next.has(p)) });
                  }}
                >
                  {perm}
                </Toggle>
              ))}
            </div>
          </div>
        </>
      )}

      {step.type !== 'end' && (
        <div>
          <div className="flex items-center justify-between">
            <p className="label-caps">Outgoing edges</p>
            <button type="button" onClick={addEdge} className="text-[10px] font-mono text-accent hover:text-accent/70 transition-colors">
              + add
            </button>
          </div>
          {stepIssues.map((i) => (
            <p key={i.message} className="text-[10px] text-[#f87171] mt-1" role="alert">
              {i.message}
            </p>
          ))}
          <div className="mt-2 space-y-2">
            {outgoing.length === 0 && <p className="text-[10px] text-muted-foreground">No edges yet.</p>}
            {outgoing.map(({ edge, index }) => {
              const edgeIssue = issues.find((i) => i.path.startsWith(`edges[${index}]`))?.message;
              return (
                <div key={index} className="rounded-md border border-border bg-input/50 p-2 space-y-1.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      aria-label="Edge event"
                      mono
                      dense
                      placeholder="event"
                      value={edge.event}
                      onChange={(e) => updateEdge(index, { event: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '') })}
                    />
                    <Input
                      aria-label="Edge label"
                      dense
                      placeholder="label"
                      value={edge.label ?? ''}
                      onChange={(e) => updateEdge(index, { label: e.target.value || undefined })}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground shrink-0">→</span>
                    <Select aria-label="Edge target" dense value={edge.to} onChange={(e) => updateEdge(index, { to: e.target.value })}>
                      {workflow.steps.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label} ({s.type})
                        </option>
                      ))}
                    </Select>
                    <button
                      type="button"
                      aria-label={`Remove edge ${edge.event}`}
                      onClick={() => removeEdge(index)}
                      className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-[#f87171] transition-colors"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  {edgeIssue && (
                    <p className="text-[10px] text-[#f87171]" role="alert">
                      {edgeIssue}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {step.type === 'human' && (
            <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
              Each edge becomes an action button. A <code className="font-mono">feedback</code> edge is triggered by chat instead.
            </p>
          )}
        </div>
      )}

      <div className="pt-2 border-t border-border">
        <Button variant="danger" size="xs" onClick={() => onDelete(step.id)} disabled={workflow.steps.length <= 1}>
          Delete step
        </Button>
      </div>
    </div>
  );
}
