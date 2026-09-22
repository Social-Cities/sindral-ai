import { useEffect, useState } from 'react';
import type { Artifact, TaskWithRelations } from '@sindral/shared';
import { EmptyState } from '@/components/EmptyState';
import { Markdown } from '@/components/Markdown';
import { formatDateTime } from '@/lib/format';

interface ArtifactsTabProps {
  task: TaskWithRelations;
}

function isMarkdown(a: Artifact): boolean {
  return /markdown|md/i.test(a.contentType) || /\.(md|markdown)$/i.test(a.name);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

export function ArtifactsTab({ task }: ArtifactsTabProps) {
  const artifacts = [...task.artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && artifacts.length > 0) setSelectedId(artifacts[0]?.id ?? null);
  }, [artifacts, selectedId]);

  if (artifacts.length === 0) {
    return <EmptyState title="No artifacts" description="Non-code deliverables produced by agents (reports, documents) appear here." />;
  }

  const selected = artifacts.find((a) => a.id === selectedId) ?? artifacts[0];

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto py-3 border-r border-border">
        <p className="label-caps px-3 mb-2">
          {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
        </p>
        <ul aria-label="Artifacts">
          {artifacts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setSelectedId(a.id)}
                aria-current={selected?.id === a.id ? 'true' : undefined}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                  selected?.id === a.id ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-secondary-foreground'
                }`}
              >
                <span className="block truncate">{a.name}</span>
                <span className="block text-[9px] text-muted-foreground/70">{a.contentType}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {selected && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <span className="text-xs font-mono text-foreground">{selected.name}</span>
              <span className="text-[10px] font-mono text-muted-foreground">{formatBytes(selected.byteSize)}</span>
              <span className="text-[10px] font-mono text-muted-foreground">{formatDateTime(selected.createdAt)}</span>
            </div>
            {selected.content === null ? (
              <div className="p-4 rounded-lg bg-muted border border-border max-w-3xl">
                <p className="text-xs text-muted-foreground mb-3">This artifact is stored securely and is not loaded into the page.</p>
                {selected.downloadUrl ? (
                  <a
                    href={selected.downloadUrl}
                    download={selected.name}
                    className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                  >
                    Download artifact
                  </a>
                ) : (
                  <p role="alert" className="text-xs text-destructive">A download link could not be authorized. Refresh to try again.</p>
                )}
              </div>
            ) : isMarkdown(selected) ? (
              <div className="p-4 rounded-lg bg-muted border border-border max-w-3xl">
                <Markdown>{selected.content}</Markdown>
              </div>
            ) : (
              <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words p-4 rounded-lg bg-muted border border-border text-[#a8b4cc]">{selected.content}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
