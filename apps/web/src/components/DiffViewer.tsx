import { useMemo } from 'react';
import type { DiffFile } from '@/lib/api';

type LineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a unified diff patch into annotated lines with old/new line numbers. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = HUNK_RE.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      lines.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      lines.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  // Drop a trailing empty context line produced by the final newline.
  const last = lines[lines.length - 1];
  if (last && last.kind === 'context' && last.text === '') lines.pop();
  return lines;
}

const KIND_CLASSES: Record<LineKind, string> = {
  add: 'bg-[#34d39912] text-[#6ee7b7]',
  del: 'bg-[#f8717112] text-[#fca5a5]',
  context: 'text-[#a8b4cc]',
  hunk: 'bg-secondary text-accent',
  meta: 'text-muted-foreground',
};

const KIND_MARK: Record<LineKind, string> = { add: '+', del: '-', context: ' ', hunk: '', meta: '' };

interface DiffViewerProps {
  file: DiffFile;
}

export function DiffViewer({ file }: DiffViewerProps) {
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border">
        <span className="text-xs font-mono text-foreground truncate">{file.filename}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase">{file.status}</span>
        <span className="text-[10px] font-mono text-[#34d399]">+{file.additions}</span>
        <span className="text-[10px] font-mono text-[#f87171]">-{file.deletions}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {lines.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            {file.patch === undefined ? 'No patch available for this file (binary or too large).' : 'Empty patch.'}
          </p>
        ) : (
          <table className="w-full text-xs font-mono leading-relaxed border-collapse" style={{ tabSize: 2 }}>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className={KIND_CLASSES[line.kind]} data-kind={line.kind}>
                  <td className="w-10 pl-3 pr-1 text-right select-none text-muted-foreground/60 align-top">{line.oldNo ?? ''}</td>
                  <td className="w-10 pr-2 text-right select-none text-muted-foreground/60 align-top">{line.newNo ?? ''}</td>
                  <td className="w-4 select-none align-top">{KIND_MARK[line.kind]}</td>
                  <td className="pr-4 whitespace-pre align-top">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
