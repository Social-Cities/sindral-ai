import { useEffect, useState } from 'react';
import type { Artifact, TaskWithRelations } from '@sindral/shared';
import { extractMarkdownSection, removeMarkdownSection } from '@sindral/shared';
import { EmptyState } from '@/components/EmptyState';
import { Markdown } from '@/components/Markdown';
import { formatDateTime } from '@/lib/format';

interface ReviewTabProps {
  task: TaskWithRelations;
}

const REVIEW_ARTIFACT = 'adversarial-review.md';
const DIFF_EXPLANATION_ARTIFACT = 'diff-explanation.md';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

interface ReviewDocument {
  id: string;
  label: 'Diff explanation' | 'Adversarial review';
  artifact: Artifact;
  content: string | null;
  order: number;
}

function reviewDocuments(task: TaskWithRelations): ReviewDocument[] {
  const artifacts = task.artifacts
    .filter((artifact) => artifact.name === DIFF_EXPLANATION_ARTIFACT || artifact.name === REVIEW_ARTIFACT)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const docs = artifacts.map((artifact): ReviewDocument => {
    if (artifact.name === DIFF_EXPLANATION_ARTIFACT) {
      return { id: artifact.id, label: 'Diff explanation', artifact, content: artifact.content, order: 0 };
    }
    return {
      id: artifact.id,
      label: 'Adversarial review',
      artifact,
      content: artifact.content ? removeMarkdownSection(artifact.content, 'Diff explanation') : null,
      order: 1,
    };
  });

  const hasDiffArtifact = artifacts.some((artifact) => artifact.name === DIFF_EXPLANATION_ARTIFACT);
  if (!hasDiffArtifact) {
    const latestCombined = artifacts.find((artifact) => artifact.name === REVIEW_ARTIFACT && artifact.content && extractMarkdownSection(artifact.content, 'Diff explanation'));
    if (latestCombined?.content) {
      docs.push({
        id: `${latestCombined.id}:diff-explanation`,
        label: 'Diff explanation',
        artifact: latestCombined,
        content: extractMarkdownSection(latestCombined.content, 'Diff explanation'),
        order: 0,
      });
    }
  }

  return docs.sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt) || a.order - b.order);
}

export function ReviewTab({ task }: ReviewTabProps) {
  const documents = reviewDocuments(task);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && documents.length > 0) setSelectedId(documents[0]?.id ?? null);
  }, [documents, selectedId]);

  if (documents.length === 0) {
    return <EmptyState title="No automated review yet" description="Diff explanation and adversarial review will appear here after review completes." />;
  }

  const selected = documents.find((document) => document.id === selectedId) ?? documents[0];

  return (
    <div className="flex h-full min-h-0">
      {documents.length > 1 && (
        <div className="w-56 shrink-0 overflow-y-auto py-3 border-r border-border">
          <p className="label-caps px-3 mb-2">Reviews</p>
          <ul aria-label="Reviews">
            {documents.map((document) => (
              <li key={document.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(document.id)}
                  aria-current={selected?.id === document.id ? 'true' : undefined}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                    selected?.id === document.id ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-secondary-foreground'
                  }`}
                >
                  <span className="block truncate">{document.label}</span>
                  <span className="block text-[9px] text-muted-foreground/70">{formatDateTime(document.artifact.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {selected && (
          <div className="max-w-4xl space-y-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{selected.label}</p>
              <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-muted-foreground">
                <span>{formatDateTime(selected.artifact.createdAt)}</span>
                <span>{formatBytes(selected.artifact.byteSize)}</span>
              </div>
            </div>

            {selected.content === null ? (
              <div className="p-4 rounded-lg bg-muted border border-border max-w-3xl">
                <p className="text-xs text-muted-foreground mb-3">This review is stored securely and is not loaded into the page.</p>
                {selected.artifact.downloadUrl ? (
                  <a
                    href={selected.artifact.downloadUrl}
                    download={selected.artifact.name}
                    className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                  >
                    Download review
                  </a>
                ) : (
                  <p role="alert" className="text-xs text-destructive">A download link could not be authorized. Refresh to try again.</p>
                )}
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-muted border border-border">
                <Markdown>{selected.content}</Markdown>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
