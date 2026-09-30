import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Project, Task, Workflow } from '@sindral/shared';
import { KNOWN_TASK_STATES, TERMINAL_STATES, dashboardBucket, getStateStyle } from '@sindral/shared';
import { StatusBadge } from '@/components/StatusBadge';
import { RelativeTime } from '@/components/RelativeTime';
import { EmptyState } from '@/components/EmptyState';
import { PageLoader } from '@/components/Spinner';
import { useTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useWorkflows } from '@/hooks/useWorkflows';
import { currentStep, resolveWorkflow } from '@/lib/taskWorkflow';

type Bucket = 'todo' | 'in-progress' | 'in-review' | 'done' | 'failed';
const BUCKETS: Bucket[] = ['todo', 'in-progress', 'in-review', 'done', 'failed'];

export function Tasks() {
  const tasksQuery = useTasks();
  const projectsQuery = useProjects();
  const workflowsQuery = useWorkflows();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const statusFilter = searchParams.get('state') ?? 'active';
  const bucketFilter = searchParams.get('bucket');
  const projectFilter = searchParams.get('projectId') ?? '';

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);

  const states = useMemo(() => {
    const seen = new Set<string>(KNOWN_TASK_STATES);
    for (const t of tasks) seen.add(t.state);
    return Array.from(seen);
  }, [tasks]);

  useEffect(() => {
    if (!filterOpen) return;
    function onClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [filterOpen]);

  function setStatus(next: string) {
    const params = new URLSearchParams(searchParams);
    params.delete('bucket');
    if (next === 'active') params.delete('state');
    else params.set('state', next);
    setSearchParams(params, { replace: true });
    setFilterOpen(false);
  }

  function setProject(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('projectId', next);
    else params.delete('projectId');
    setSearchParams(params, { replace: true });
  }

  const { parents, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.parentTaskId) {
        const list = childrenOf.get(t.parentTaskId) ?? [];
        list.push(t);
        childrenOf.set(t.parentTaskId, list);
      }
    }
    for (const list of childrenOf.values()) list.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const parentIds = new Set(tasks.map((t) => t.id));
    // Orphaned subtasks (parent not in list) are shown as top-level cards.
    const parents = tasks.filter((t) => !t.parentTaskId || !parentIds.has(t.parentTaskId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { parents, childrenOf };
  }, [tasks]);

  const q = search.trim().toLowerCase();
  const matches = (t: Task) => {
    const matchesSearch = !q || t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    const matchesStatus = bucketFilter
      ? true
      : statusFilter === 'all'
        ? true
        : statusFilter === 'active'
          ? !TERMINAL_STATES.has(t.state)
          : t.state === statusFilter;
    const matchesBucket = !bucketFilter || dashboardBucket(t.state, currentStep(t, workflows)) === bucketFilter;
    const matchesProject = !projectFilter || t.projectId === projectFilter;
    return matchesSearch && matchesStatus && matchesBucket && matchesProject;
  };

  const filtered = parents.flatMap((parent) => {
    if (matches(parent)) return [parent];
    const matchingChildren = (childrenOf.get(parent.id) ?? []).filter(matches);
    return TERMINAL_STATES.has(parent.state) ? matchingChildren : matchingChildren.length > 0 ? [parent] : [];
  });
  const visibleCount = filtered.length;
  const filterLabel = bucketFilter ? bucketFilter.replace('-', ' ') : statusFilter === 'active' ? 'Active' : statusFilter === 'all' ? 'All statuses' : getStateStyle(statusFilter).label;

  return (
    <div className="h-full flex flex-col md:flex-row">
      <aside className="w-full md:w-60 shrink-0 flex flex-col border-b md:border-b-0 md:border-r border-border bg-muted">
        <div className="p-4 space-y-3">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M8 8L10.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              aria-label="Search tasks"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md outline-none text-foreground placeholder:text-muted-foreground font-sans transition-colors bg-input border border-border focus:border-accent/40"
            />
          </div>

          <div className="relative" ref={filterRef}>
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={filterOpen}
              aria-label="Filter by status"
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs transition-colors bg-input border border-border ${
                statusFilter === 'active' && !bucketFilter ? 'text-muted-foreground' : 'text-foreground'
              }`}
            >
              <span className="flex items-center gap-1.5 capitalize">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <path d="M1 2.5h9M2.5 5.5h6M4 8.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                {filterLabel}
              </span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`transition-transform ${filterOpen ? 'rotate-180' : ''}`} aria-hidden="true">
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>

            {filterOpen && (
              <div role="listbox" aria-label="Status" className="absolute top-full left-0 right-0 mt-1 rounded-md overflow-hidden z-10 py-1 bg-card border border-border max-h-72 overflow-y-auto">
                <FilterOption active={statusFilter === 'active' && !bucketFilter} onClick={() => setStatus('active')}>
                  Active
                </FilterOption>
                <FilterOption active={statusFilter === 'all' && !bucketFilter} onClick={() => setStatus('all')}>
                  All statuses
                </FilterOption>
                {states.map((s) => (
                  <FilterOption key={s} active={statusFilter === s} onClick={() => setStatus(s)}>
                    <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5" style={{ background: getStateStyle(s).color }} aria-hidden="true" />
                    {getStateStyle(s).label}
                  </FilterOption>
                ))}
              </div>
            )}
          </div>
          {bucketFilter && (
            <p className="text-[10px] text-muted-foreground">
              Showing the <span className="text-secondary-foreground">{bucketFilter.replace('-', ' ')}</span> bucket ·{' '}
              <button type="button" className="text-accent" onClick={() => setStatus('active')}>
                clear
              </button>
            </p>
          )}
          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(event) => setProject(event.target.value)}
            className="w-full rounded-md outline-none text-xs text-foreground bg-input border border-border px-2.5 py-1.5 focus:border-accent/40"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="px-4 pb-2 hidden md:block">
          <p className="text-xs text-muted-foreground">
            {visibleCount} task{visibleCount === 1 ? '' : 's'}
          </p>
        </div>
        {!BUCKETS.includes(bucketFilter as Bucket) && bucketFilter && <p className="px-4 text-[10px] text-[#f87171]">Unknown bucket filter.</p>}
      </aside>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {tasksQuery.isLoading ? (
          <PageLoader />
        ) : tasksQuery.isError ? (
          <EmptyState title="Could not load tasks" description={tasksQuery.error instanceof Error ? tasksQuery.error.message : undefined} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={tasks.length === 0 ? 'No tasks yet' : 'No tasks match your filters'}
            description={
              tasks.length === 0 ? (
                <>
                  Create one from the{' '}
                  <Link to="/" className="text-accent">
                    home page
                  </Link>
                  .
                </>
              ) : statusFilter === 'active' && !bucketFilter && !q ? (
                <>Done and won&apos;t-do tasks are hidden. Use the status filter to show them.</>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 max-w-4xl">
            {filtered.map((task) => {
              const children = childrenOf.get(task.id) ?? [];
              const visibleChildren = children.filter(matches);
              return (
                <div key={task.id}>
                  <TaskRow task={task} workflows={workflows} project={task.projectId ? projectById.get(task.projectId) : undefined} subtaskCount={children.length} subtaskDone={children.filter((c) => c.state === 'done').length} />
                  {visibleChildren.length > 0 && (
                    <div className="ml-6 mt-1.5 space-y-1.5 border-l border-border pl-3" aria-label={`Subtasks of ${task.key}`}>
                      {visibleChildren.map((child) => (
                        <TaskRow key={child.id} task={child} workflows={workflows} project={child.projectId ? projectById.get(child.projectId) : undefined} compact />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterOption({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${active ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-secondary-foreground'}`}
    >
      {children}
    </button>
  );
}

interface TaskRowProps {
  task: Task;
  workflows: Workflow[];
  project?: Project;
  compact?: boolean;
  subtaskCount?: number;
  subtaskDone?: number;
}

export function TaskRow({ task, workflows, project, compact = false, subtaskCount = 0, subtaskDone = 0 }: TaskRowProps) {
  const wf = resolveWorkflow(task, workflows);
  const isPinned = !!task.pinnedWorkflow;
  const step = currentStep(task, workflows);
  return (
    <Link
      to={`/tasks/${task.id}`}
      data-testid="task-card"
      className={`block w-full text-left rounded-lg transition-all bg-card border border-border hover:border-border-strong ${compact ? 'px-4 py-3' : 'px-5 py-4'}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {compact && task.sequence != null && <span className="text-[10px] font-mono text-muted-foreground">↳ {task.sequence}</span>}
            <span className="text-xs font-mono text-muted-foreground">{task.key}</span>
            {project && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{project.name}</span>}
            {task.ticketUrl && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">linked</span>}
            {task.prUrl && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-accent" style={{ background: '#818cf810' }}>
                PR open
              </span>
            )}
            {subtaskCount > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground" title="Subtasks done / total">
                ↳ {subtaskDone}/{subtaskCount}
              </span>
            )}
            {wf && (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1 bg-secondary border border-border"
                style={{ color: isPinned ? '#34d399' : '#52596b' }}
                title={isPinned ? "Pinned to workflow snapshot — updates to the workflow won't affect this task" : 'Using live workflow'}
              >
                {isPinned ? '📌' : '⬡'} {wf.name}
              </span>
            )}
          </div>
          <p className={`font-medium text-foreground leading-snug ${compact ? 'text-xs' : 'text-sm'}`}>{task.title}</p>
          {!compact && <p className="text-xs text-muted-foreground mt-1.5 line-clamp-1 leading-relaxed">{task.description}</p>}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <StatusBadge state={task.state} step={step} />
          <RelativeTime iso={task.updatedAt} className="text-[10px] font-mono text-muted-foreground" />
        </div>
      </div>
    </Link>
  );
}
