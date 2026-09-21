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
  const hasPr = !!task.prUrl;
  const diff = useTaskDiff(task.id, { enabled: hasPr });
  const [selected, setSelected] = useState<string | null>(null);

  const files = useMemo(() => diff.data ?? [], [diff.data]);
  const tree = useMemo(() => buildFileTree(files), [files]);

  useEffect(() => {
    if (!selected && files.length > 0) setSelected(files[0]?.filename ?? null);
  }, [files, selected]);

  if (!hasPr) {
    return <EmptyState title="No pull request yet" description="The diff appears here once an implementation agent opens a PR for this task." />;
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

  const file = files.find((f) => f.filename === selected) ?? files[0];

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto py-3 border-r border-border">
        <p className="label-caps px-3 mb-2">
          {files.length} file{files.length === 1 ? '' : 's'}
        </p>
        <FileTree nodes={tree} selected={file?.filename ?? null} onSelect={setSelected} />
      </div>
      <div className="flex-1 min-w-0 min-h-0">{file && <DiffViewer file={file} />}</div>
    </div>
  );
}
