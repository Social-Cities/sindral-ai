import { useMemo, useState } from 'react';
import type { DiffFile } from '@/lib/api';

type LineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';
type TokenKind = 'plain' | 'comment' | 'keyword' | 'string' | 'number' | 'punctuation' | 'type' | 'builtin';

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

interface SyntaxToken {
  kind: TokenKind;
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const WORD_RE = /^[A-Za-z_$][\w$]*$/;
const TOKEN_RE =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|#.*|\/\*.*?\*\/|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\],.;:<>/?=+\-*%!&|^~]+)/g;

const KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'for',
  'from',
  'func',
  'function',
  'guard',
  'if',
  'import',
  'in',
  'interface',
  'let',
  'mutating',
  'new',
  'nil',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'self',
  'static',
  'struct',
  'super',
  'switch',
  'throw',
  'throws',
  'true',
  'try',
  'type',
  'typealias',
  'var',
  'void',
  'while',
  'with',
]);

const BUILTINS = new Set(['Array', 'Boolean', 'Date', 'Error', 'JSON', 'Map', 'Number', 'Object', 'Promise', 'Set', 'String', 'console', 'document', 'window']);
const TYPES = new Set(['Bool', 'Boolean', 'Double', 'Float', 'Int', 'Record', 'String', 'Void', 'any', 'boolean', 'never', 'number', 'string', 'unknown', 'void']);

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
  add: 'bg-[var(--color-diff-add-bg)] text-[var(--color-diff-add-text)]',
  del: 'bg-[var(--color-diff-del-bg)] text-[var(--color-diff-del-text)]',
  context: 'text-[var(--color-diff-context-text)]',
  hunk: 'bg-[var(--color-diff-hunk-bg)] text-accent',
  meta: 'text-muted-foreground',
};

const KIND_MARK: Record<LineKind, string> = { add: '+', del: '-', context: ' ', hunk: '', meta: '' };
const TOKEN_CLASSES: Record<TokenKind, string> = {
  plain: '',
  comment: 'text-[var(--color-syntax-comment)] italic',
  keyword: 'text-[var(--color-syntax-keyword)] font-semibold',
  string: 'text-[var(--color-syntax-string)]',
  number: 'text-[var(--color-syntax-number)]',
  punctuation: 'text-[var(--color-syntax-punctuation)]',
  type: 'text-[var(--color-syntax-type)]',
  builtin: 'text-[var(--color-syntax-builtin)]',
};

interface DiffViewerProps {
  file: DiffFile;
}

export function DiffViewer({ file }: DiffViewerProps) {
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const [wrapLines, setWrapLines] = useState(false);
  const [copied, setCopied] = useState(false);
  const language = useMemo(() => inferLanguage(file.filename), [file.filename]);
  const hunkCount = lines.filter((line) => line.kind === 'hunk').length;

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(file.filename);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-diff-surface)]">
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border bg-card/70">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-foreground truncate" title={file.filename}>
              {file.filename}
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase">{file.status}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
            <span>{language.label}</span>
            <span>
              {hunkCount} hunk{hunkCount === 1 ? '' : 's'}
            </span>
            <span className="text-[var(--color-success)]">+{file.additions}</span>
            <span className="text-[var(--color-danger)]">-{file.deletions}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setWrapLines((value) => !value)}
          className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
            wrapLines ? 'border-accent/50 bg-accent/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {wrapLines ? 'Wrap on' : 'Wrap off'}
        </button>
        <button type="button" onClick={copyPath} className="rounded border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
          {copied ? 'Copied' : 'Copy path'}
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {lines.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            {file.patch === undefined ? 'No patch available for this file (binary or too large).' : 'Empty patch.'}
          </p>
        ) : (
          <table className="w-full text-xs font-mono leading-relaxed border-collapse" style={{ tabSize: 2 }}>
            <thead className="sticky top-0 z-10 bg-card/95 text-[10px] uppercase tracking-[0.08em] text-muted-foreground shadow-[0_1px_0_var(--color-border)]">
              <tr>
                <th scope="col" className="w-12 py-1.5 pl-3 pr-1 text-right font-medium">
                  Old
                </th>
                <th scope="col" className="w-12 py-1.5 pr-2 text-right font-medium">
                  New
                </th>
                <th scope="col" className="w-4 py-1.5 font-medium">
                  <span className="sr-only">Change marker</span>
                </th>
                <th scope="col" className="py-1.5 pr-4 text-left font-medium">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className={`${KIND_CLASSES[line.kind]} hover:bg-[var(--color-diff-hover-bg)]`} data-kind={line.kind}>
                  <td className="w-12 pl-3 pr-1 text-right select-none text-muted-foreground/55 align-top border-r border-border/50">{line.oldNo ?? ''}</td>
                  <td className="w-12 pr-2 text-right select-none text-muted-foreground/55 align-top border-r border-border/50">{line.newNo ?? ''}</td>
                  <td className="w-4 select-none align-top text-muted-foreground/80">{KIND_MARK[line.kind]}</td>
                  <td className={`pr-4 align-top ${wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
                    {line.kind === 'hunk' || line.kind === 'meta' ? line.text : <HighlightedCode language={language.id} text={line.text} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function HighlightedCode({ text, language }: { text: string; language: string }) {
  return (
    <>
      {tokenizeLine(text, language).map((token, index) =>
        token.kind === 'plain' ? (
          token.text
        ) : (
          <span key={`${token.kind}-${index}`} className={TOKEN_CLASSES[token.kind]}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

export function inferLanguage(filename: string): { id: string; label: string } {
  const name = filename.toLowerCase();
  const ext = name.split('.').pop() ?? '';
  if (name.endsWith('.tsx')) return { id: 'tsx', label: 'TSX' };
  if (name.endsWith('.jsx')) return { id: 'jsx', label: 'JSX' };
  if (ext === 'ts') return { id: 'ts', label: 'TypeScript' };
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return { id: 'js', label: 'JavaScript' };
  if (ext === 'swift') return { id: 'swift', label: 'Swift' };
  if (ext === 'css') return { id: 'css', label: 'CSS' };
  if (ext === 'json') return { id: 'json', label: 'JSON' };
  if (ext === 'md' || ext === 'mdx') return { id: 'markdown', label: 'Markdown' };
  if (ext === 'sql') return { id: 'sql', label: 'SQL' };
  if (ext === 'yml' || ext === 'yaml') return { id: 'yaml', label: 'YAML' };
  if (ext === 'sh' || ext === 'zsh' || ext === 'bash') return { id: 'shell', label: 'Shell' };
  return { id: 'text', label: 'Plain text' };
}

export function tokenizeLine(text: string, language: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let index = 0;
  TOKEN_RE.lastIndex = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (start > index) tokens.push({ kind: 'plain', text: text.slice(index, start) });
    tokens.push({ kind: classifyToken(value, language), text: value });
    index = start + value.length;
  }

  if (index < text.length) tokens.push({ kind: 'plain', text: text.slice(index) });
  return tokens;
}

function classifyToken(value: string, language: string): TokenKind {
  if (value.startsWith('//') || value.startsWith('/*')) return 'comment';
  if (value.startsWith('#') && ['markdown', 'shell', 'yaml'].includes(language)) return 'comment';
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return 'string';
  if (/^\d/.test(value)) return 'number';
  if (WORD_RE.test(value)) {
    if (KEYWORDS.has(value)) return 'keyword';
    if (TYPES.has(value)) return 'type';
    if (BUILTINS.has(value)) return 'builtin';
  }
  if (/^[{}()[\],.;:<>/?=+\-*%!&|^~]+$/.test(value)) return 'punctuation';
  return 'plain';
}
