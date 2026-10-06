import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { TaskWithRelations } from '@sindral/shared';
import { DiffViewer } from '@/components/DiffViewer';
import { EmptyState } from '@/components/EmptyState';
import { FileTree, buildFileTree } from '@/components/FileTree';
import { PageLoader } from '@/components/Spinner';
import { useTaskDiff } from '@/hooks/useTasks';
import { ApiError } from '@/lib/api';

interface CodeTabProps {
  task: TaskWithRelations;
}

export function CodeTab({ task }: CodeTabProps) {
  const [repository, setRepository] = useState(task.pullRequests[0]?.repository ?? '');
  const hasPr = task.pullRequests.length > 0 || !!task.prUrl;
  const diff = useTaskDiff(task.id, repository || undefined, { enabled: hasPr });
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const files = useMemo(() => diff.data ?? [], [diff.data]);
  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => `${file.filename} ${file.status}`.toLowerCase().includes(needle));
  }, [files, query]);
  const tree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );

  useEffect(() => {
    if (!selected && files.length > 0) setSelected(files[0]?.filename ?? null);
  }, [files, selected]);

  useEffect(() => {
    if (visibleFiles.length === 0) return;
    if (!selected || !visibleFiles.some((file) => file.filename === selected)) setSelected(visibleFiles[0]?.filename ?? null);
  }, [selected, visibleFiles]);

  if (!hasPr) {
    return <EmptyState title="No pull request yet" description="The diff appears here once the review slicer opens a PR for this task." />;
  }
  if (diff.isLoading) return <PageLoader label="Loading diff…" />;
  if (diff.isError) {
    const err = diff.error;
    if (err instanceof ApiError && err.status === 400) {
      return (
        <EmptyState
          title="GitHub token required"
          description={
            <>
              Configure a GitHub token in{' '}
              <Link to="/settings" className="text-accent">
                Settings
              </Link>{' '}
              to view the pull request diff.
            </>
          }
        />
      );
    }
    return <EmptyState title="Could not load the diff" description={err instanceof Error ? err.message : undefined} />;
  }
  if (files.length === 0) {
    return <EmptyState title="No changed files" description="The pull request has no file changes yet." />;
  }

  const file = visibleFiles.find((f) => f.filename === selected) ?? visibleFiles[0];

  return (
    <div className="flex h-full min-h-0 relative">
      <div className="w-72 shrink-0 overflow-y-auto py-3 border-r border-border bg-card/35">
        {task.pullRequests.length > 1 && (
          <div className="px-3 mb-3">
            <label className="label-caps block mb-1" htmlFor="diff-repository">
              Repository
            </label>
            <select
              id="diff-repository"
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
                setSelected(null);
              }}
              className="w-full bg-input border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground"
            >
              {task.pullRequests.map((pr) => (
                <option key={pr.id} value={pr.repository}>
                  {pr.repository}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="px-3 mb-3">
          <div className="flex items-center justify-between gap-2">
            <p className="label-caps">
              {files.length} file{files.length === 1 ? '' : 's'}
            </p>
            <p className="text-[10px] font-mono">
              <span className="text-[var(--color-success)]">+{totals.additions}</span>
              <span className="text-muted-foreground mx-1">/</span>
              <span className="text-[var(--color-danger)]">-{totals.deletions}</span>
            </p>
          </div>
          <label className="label-caps block mt-3 mb-1" htmlFor="diff-file-search">
            Find file
          </label>
          <input
            id="diff-file-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search path or status"
            className="w-full bg-input border border-border rounded px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>
        {visibleFiles.length === 0 ? (
          <p className="px-3 py-8 text-xs text-muted-foreground">No changed files match that search.</p>
        ) : (
          <FileTree nodes={tree} selected={file?.filename ?? null} onSelect={setSelected} />
        )}
      </div>
      <div className="flex-1 min-w-0 min-h-0">{file ? <DiffViewer file={file} /> : <EmptyState title="No file selected" description="Choose a changed file from the list." />}</div>
    </div>
  );
}
