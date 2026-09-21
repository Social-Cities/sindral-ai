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
              <span className="text-[10px] font-mono text-muted-foreground">{formatDateTime(selected.createdAt)}</span>
            </div>
            {isMarkdown(selected) ? (
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
