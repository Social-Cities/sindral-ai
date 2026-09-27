import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CreateTaskInput, TicketImport, Worker } from '@sindral/shared';
import { TERMINAL_STATES, dashboardBucket, detectTicket, normalizeRepo } from '@sindral/shared';
import { displayNameFor, useAuth } from '@/auth/AuthProvider';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/Button';
import { useCreateTask, useTasks } from '@/hooks/useTasks';
import { useWorkflows } from '@/hooks/useWorkflows';
import { useWorkers } from '@/hooks/useWorkers';
import { useMe } from '@/hooks/useSettings';
import { importTicket } from '@/lib/api';
import { greetingForHour } from '@/lib/format';
import { currentStep } from '@/lib/taskWorkflow';

const MAX_UPLOAD_BYTES = 1024 * 1024;

type Mode = 'text' | 'url';

const PROVIDER_LABEL: Record<TicketImport['provider'], string> = { linear: 'Linear', jira: 'Jira', github: 'GitHub' };

export function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const me = useMe();
  const tasksQuery = useTasks();
  const workflowsQuery = useWorkflows();
  const workersQuery = useWorkers();
  const createTask = useCreateTask();

  const [mode, setMode] = useState<Mode>('text');
  const [textInput, setTextInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [ticket, setTicket] = useState<TicketImport | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [reposInput, setReposInput] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  useEffect(() => {
    if (!workflowId && workflows.length > 0) {
      const preferred = workflows.find((w) => w.isDefault) ?? workflows[0];
      if (preferred) setWorkflowId(preferred.id);
    }
  }, [workflows, workflowId]);

  const counts = useMemo(() => {
    const c = { todo: 0, 'in-progress': 0, 'in-review': 0, done: 0, failed: 0 };
    for (const t of tasks) {
      if (t.parentTaskId) continue;
      c[dashboardBucket(t.state, currentStep(t, workflows))] += 1;
    }
    return c;
  }, [tasks, workflows]);

  const activeTasks = useMemo(
    () =>
      tasks
        .filter((t) => !t.parentTaskId && t.state !== 'todo' && !TERMINAL_STATES.has(t.state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 4),
    [tasks],
  );

  const name = me.data?.displayName ?? displayNameFor(user);
  const greeting = greetingForHour(new Date().getHours());

  const detected = mode === 'url' ? detectTicket(urlInput) : null;
  const title = mode === 'url' ? ticket?.title ?? '' : (textInput.trim().split('\n')[0] ?? '').slice(0, 200);
  const canCreate = mode === 'text' ? !!textInput.trim() : !!ticket;

  function parseRepos(): string[] | null {
    const raw = reposInput
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const repos: string[] = [];
    for (const r of raw) {
      const n = normalizeRepo(r);
      if (!n) {
        setFormError(`"${r}" is not a valid repository. Use owner/name.`);
        return null;
      }
      if (!repos.includes(n)) repos.push(n);
    }
    return repos;
  }

  async function handleImport() {
    if (!urlInput.trim()) return;
    setImportError(null);
    setImporting(true);
    try {
      const { ticket: t } = await importTicket(urlInput.trim());
      setTicket(t);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not import ticket');
    } finally {
      setImporting(false);
    }
  }

  async function handleCreate() {
    if (!canCreate || createTask.isPending) return;
    setFormError(null);
    const repos = parseRepos();
    if (!repos) return;

    let input: CreateTaskInput;
    if (mode === 'text') {
      input = { title, description: textInput.trim(), repos, workflowId: workflowId || undefined };
    } else if (ticket) {
      const key = /^[A-Z][A-Z0-9]*-\d+$/.test(ticket.id) ? ticket.id : undefined;
      input = {
        title: ticket.title,
        description: ticket.description,
        ticketUrl: ticket.url,
        key,
        repos,
        workflowId: workflowId || undefined,
      };
    } else {
      return;
    }

    try {
      await createTask.mutateAsync(input);
      setTextInput('');
      setUrlInput('');
      setTicket(null);
      setReposInput('');
      navigate('/tasks');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create task');
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleCreate();
    }
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadNote(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadNote('File is larger than 1 MB.');
      return;
    }
    if (!/\.(md|txt|markdown)$/i.test(file.name)) {
      setUploadNote('Only .md and .txt files are supported.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      setMode('text');
      setTextInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${content}` : content));
      setUploadNote(`Loaded ${file.name}`);
      textRef.current?.focus();
    };
    reader.onerror = () => setUploadNote('Could not read the file.');
    reader.readAsText(file);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-12">
        <div className="mb-10">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">
            {greeting}, {name}.
          </h1>
          <p className="text-sm text-muted-foreground mt-1">What would you like to work on today?</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
          <div className="lg:col-span-2 space-y-6">
            {/* Task creation card */}
            <div className="rounded-lg overflow-hidden bg-card border border-border">
              <div className="flex border-b border-border" role="tablist" aria-label="Task source">
                {(['text', 'url'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => setMode(m)}
                    className={`px-4 py-2.5 text-xs font-medium transition-colors relative ${
                      mode === m ? 'text-foreground' : 'text-muted-foreground hover:text-secondary-foreground'
                    }`}
                  >
                    {m === 'text' ? 'New task' : 'Paste a URL'}
                    {mode === m && <span className="absolute bottom-0 left-0 right-0 h-px bg-accent" />}
                  </button>
                ))}
              </div>

              <div className="p-4">
                {mode === 'text' ? (
                  <textarea
                    ref={textRef}
                    aria-label="Task description"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Describe the task in detail. Include the problem, expected behavior, and any relevant context..."
                    className="w-full h-32 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none leading-relaxed"
                  />
                ) : (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        aria-label="Ticket URL"
                        value={urlInput}
                        onChange={(e) => {
                          setUrlInput(e.target.value);
                          setTicket(null);
                          setImportError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleImport();
                          }
                        }}
                        placeholder="https://linear.app/org/issue/ENG-123"
                        className="flex-1 text-sm outline-none rounded px-3 py-2 font-mono placeholder:text-muted-foreground text-foreground bg-input border border-border focus:border-accent/40 transition-colors"
                      />
                      <Button variant="subtle" onClick={handleImport} disabled={!detected} loading={importing}>
                        Import
                      </Button>
                    </div>
                    {importError && (
                      <p className="text-xs text-[#f87171]" role="alert">
                        {importError}
                      </p>
                    )}
                    {ticket ? (
                      <div className="rounded-md bg-input border border-border p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-accent">{PROVIDER_LABEL[ticket.provider]}</span>
                          <span className="text-xs font-mono text-muted-foreground">{ticket.id}</span>
                        </div>
                        <input
                          aria-label="Imported title"
                          value={ticket.title}
                          onChange={(e) => setTicket({ ...ticket, title: e.target.value })}
                          className="w-full bg-transparent text-sm font-medium text-foreground outline-none"
                        />
                        <textarea
                          aria-label="Imported description"
                          value={ticket.description}
                          onChange={(e) => setTicket({ ...ticket, description: e.target.value })}
                          onKeyDown={handleKeyDown}
                          rows={5}
                          className="w-full bg-transparent text-xs text-secondary-foreground outline-none resize-none leading-relaxed"
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {detected
                          ? `Detected a ${PROVIDER_LABEL[detected.provider]} ticket (${detected.id}). Import to pre-fill the task.`
                          : 'Paste a Linear, Jira, or GitHub issue URL. Sindral will import the ticket title, description, and metadata automatically.'}
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-muted-foreground shrink-0" aria-hidden="true">
                    <path d="M1.5 3h8v6h-8zM1.5 3l2-1.5h4l2 1.5" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
                  </svg>
                  <input
                    aria-label="Repositories"
                    value={reposInput}
                    onChange={(e) => {
                      setReposInput(e.target.value);
                      setFormError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Repositories: owner/name, owner/other (leave empty for a non-code task)"
                    className="flex-1 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground outline-none"
                  />
                </div>
                {formError && (
                  <p className="text-xs text-[#f87171] mt-2" role="alert">
                    {formError}
                  </p>
                )}
              </div>

              <div className="px-4 pb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-secondary-foreground transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M10 7.5V10H2V7.5M6 1.5V7.5M6 1.5L3.5 4M6 1.5L8.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Upload plan
                  </button>
                  <input ref={fileRef} type="file" accept=".md,.txt,.markdown,text/markdown,text/plain" className="hidden" onChange={handleFile} aria-label="Upload plan file" />
                  {uploadNote && <span className="text-[10px] text-muted-foreground">{uploadNote}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-muted-foreground shrink-0" aria-hidden="true">
                      <circle cx="2" cy="2" r="1.2" stroke="currentColor" strokeWidth="1" />
                      <circle cx="9" cy="2" r="1.2" stroke="currentColor" strokeWidth="1" />
                      <circle cx="5.5" cy="9" r="1.2" stroke="currentColor" strokeWidth="1" />
                      <path d="M3.2 2h4.6M3.2 9H5.5M9 3.2V5.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                    </svg>
                    <select
                      aria-label="Workflow"
                      value={workflowId}
                      onChange={(e) => setWorkflowId(e.target.value)}
                      className="text-xs text-muted-foreground bg-transparent outline-none appearance-none cursor-pointer hover:text-secondary-foreground transition-colors"
                    >
                      {workflows.length === 0 && <option value="">No workflows</option>}
                      {workflows.map((wf) => (
                        <option key={wf.id} value={wf.id}>
                          {wf.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button onClick={handleCreate} disabled={!canCreate} loading={createTask.isPending} title="Cmd+Enter">
                    Create task ↵
                  </Button>
                </div>
              </div>
            </div>

            {/* Active tasks */}
            {activeTasks.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Active tasks</h2>
                  <Link to="/tasks" className="text-xs text-accent hover:text-accent/70 transition-colors">
                    View all →
                  </Link>
                </div>
                <div className="space-y-1.5">
                  {activeTasks.map((task) => (
                    <Link
                      key={task.id}
                      to={`/tasks/${task.id}`}
                      className="w-full text-left flex items-center justify-between px-4 py-3 rounded-lg transition-colors bg-card border border-border hover:border-border-strong"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{task.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 font-mono">{task.key}</p>
                      </div>
                      <StatusBadge state={task.state} step={currentStep(task, workflows)} />
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Stats column */}
          <div className="space-y-3">
            {[
              { label: 'Tasks in Todo', value: counts.todo, color: '#8b92a8', sub: 'Awaiting start', filter: 'todo' },
              { label: 'In Progress', value: counts['in-progress'], color: '#a78bfa', sub: 'Agent working', filter: 'in-progress' },
              { label: 'In Review', value: counts['in-review'], color: '#22d3ee', sub: 'Needs approval', filter: 'in-review' },
            ].map(({ label, value, color, sub, filter }) => (
              <Link
                key={label}
                to={`/tasks?bucket=${filter}`}
                className="block w-full text-left p-5 rounded-lg transition-colors bg-card border border-border hover:border-border-strong"
              >
                <div className="text-4xl font-semibold tabular-nums leading-none" style={{ color }}>
                  {tasksQuery.isLoading ? '–' : value}
                </div>
                <div className="text-sm font-medium text-foreground mt-2">{label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
              </Link>
            ))}

            <WorkerPanel workers={workersQuery.data ?? []} loading={workersQuery.isLoading} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkerPanel({ workers, loading }: { workers: Worker[]; loading: boolean }) {
  const online = workers.filter((w) => w.status === 'online');
  const running = online.reduce((n, w) => n + w.runningJobs, 0);
  return (
    <div className="p-4 rounded-lg bg-muted border border-dashed border-border" data-testid="worker-panel">
      {loading ? (
        <p className="text-xs text-muted-foreground">Checking workers…</p>
      ) : online.length === 0 ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          No worker connected —{' '}
          <Link to="/settings" className="text-accent underline underline-offset-2 hover:text-accent/70">
            see Settings
          </Link>
          {workers.length > 0 && <span className="block mt-1">{workers.length} registered, all offline.</span>}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="text-secondary-foreground font-medium">
              {online.length} worker{online.length === 1 ? '' : 's'}
            </span>{' '}
            connected · {running > 0 ? `${running} job${running === 1 ? '' : 's'} running` : 'idle'}
          </p>
          <ul className="mt-2 space-y-1">
            {online.map((w) => (
              <li key={w.id} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                <span className="text-xs text-muted-foreground font-mono truncate">
                  {w.name} · {w.hostname}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
