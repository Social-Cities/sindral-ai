import { useEffect, useState } from 'react';
import type { Artifact, TaskWithRelations } from '@sindral/shared';
import { EmptyState } from '@/components/EmptyState';
import { Markdown } from '@/components/Markdown';
import { formatDateTime } from '@/lib/format';

interface ReviewTabProps {
  task: TaskWithRelations;
}

const REVIEW_ARTIFACT = 'adversarial-review.md';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function headingText(line: string): { depth: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (!match) return null;
  return { depth: match[1]!.length, text: match[2]!.trim().toLowerCase() };
}

export function extractMarkdownSection(markdown: string, title: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const target = title.trim().toLowerCase();
  const startIndex = lines.findIndex((line) => headingText(line)?.text === target);
  if (startIndex === -1) return null;

  const startHeading = headingText(lines[startIndex]!);
  if (!startHeading) return null;
  const endIndex = lines.findIndex((line, index) => {
    if (index <= startIndex) return false;
    const heading = headingText(line);
    return Boolean(heading && heading.depth <= startHeading.depth);
  });
  return lines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex).join('\n').trim() || null;
}

function reviewArtifacts(task: TaskWithRelations): Artifact[] {
  return task.artifacts
    .filter((artifact) => artifact.name === REVIEW_ARTIFACT)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function ReviewTab({ task }: ReviewTabProps) {
  const artifacts = reviewArtifacts(task);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && artifacts.length > 0) setSelectedId(artifacts[0]?.id ?? null);
  }, [artifacts, selectedId]);

  if (artifacts.length === 0) {
    return <EmptyState title="No automated review yet" description="The diff explanation will appear here after adversarial review completes." />;
  }

  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  const diffExplanation = selected?.content ? extractMarkdownSection(selected.content, 'Diff explanation') : null;

  return (
    <div className="flex h-full min-h-0">
      {artifacts.length > 1 && (
        <div className="w-56 shrink-0 overflow-y-auto py-3 border-r border-border">
          <p className="label-caps px-3 mb-2">Review runs</p>
          <ul aria-label="Review runs">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(artifact.id)}
                  aria-current={selected?.id === artifact.id ? 'true' : undefined}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                    selected?.id === artifact.id ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-secondary-foreground'
                  }`}
                >
                  <span className="block truncate">{formatDateTime(artifact.createdAt)}</span>
                  <span className="block text-[9px] text-muted-foreground/70">{formatBytes(artifact.byteSize)}</span>
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
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Automated review</p>
              <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-muted-foreground">
                <span>{formatDateTime(selected.createdAt)}</span>
                <span>{formatBytes(selected.byteSize)}</span>
              </div>
            </div>

            {selected.content === null ? (
              <div className="p-4 rounded-lg bg-muted border border-border max-w-3xl">
                <p className="text-xs text-muted-foreground mb-3">This review is stored securely and is not loaded into the page.</p>
                {selected.downloadUrl ? (
                  <a
                    href={selected.downloadUrl}
                    download={selected.name}
                    className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                  >
                    Download review
                  </a>
                ) : (
                  <p role="alert" className="text-xs text-destructive">A download link could not be authorized. Refresh to try again.</p>
                )}
              </div>
            ) : (
              <>
                <section>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Diff explanation</p>
                  <div className="p-4 rounded-lg bg-muted border border-border">
                    <Markdown>{diffExplanation ?? selected.content}</Markdown>
                  </div>
                </section>

                {diffExplanation && (
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Full review</p>
                    <div className="p-4 rounded-lg bg-muted border border-border">
                      <Markdown>{selected.content}</Markdown>
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
