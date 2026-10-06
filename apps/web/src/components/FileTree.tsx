import { useMemo, useState } from 'react';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children: FileTreeNode[];
  meta?: { additions: number; deletions: number; status: string };
}

/** Build a nested tree from flat `a/b/c.ts` paths; directories first, alphabetical. */
export function buildFileTree(files: { filename: string; additions?: number; deletions?: number; status?: string }[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', type: 'dir', children: [] };
  for (const file of files) {
    const parts = file.filename.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.name === part && c.type === (isLeaf ? 'file' : 'dir'));
      if (!child) {
        child = { name: part, path, type: isLeaf ? 'file' : 'dir', children: [] };
        if (isLeaf) child.meta = { additions: file.additions ?? 0, deletions: file.deletions ?? 0, status: file.status ?? 'modified' };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

interface FileTreeProps {
  nodes: FileTreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
}

export function FileTree({ nodes, selected, onSelect }: FileTreeProps) {
  return (
    <ul role="tree" aria-label="Changed files" className="text-xs font-mono space-y-0.5 px-2">
      {nodes.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function TreeItem({ node, depth, selected, onSelect }: { node: FileTreeNode; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(true);
  const isSelected = selected === node.path;
  const children = useMemo(() => node.children, [node.children]);
  const status = node.meta ? statusMeta(node.meta.status) : null;

  return (
    <li role="treeitem" aria-expanded={node.type === 'dir' ? open : undefined} aria-selected={node.type === 'file' ? isSelected : undefined}>
      <button
        type="button"
        onClick={() => (node.type === 'dir' ? setOpen((o) => !o) : onSelect(node.path))}
        aria-label={node.type === 'dir' ? `${open ? 'Collapse' : 'Expand'} ${node.path}` : node.path}
        className={`w-full min-w-0 text-left flex items-center gap-1.5 py-1 pr-2 rounded transition-colors ${
          isSelected ? 'text-foreground bg-secondary shadow-[inset_2px_0_0_var(--color-accent)]' : 'text-muted-foreground hover:text-secondary-foreground hover:bg-secondary/50'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={node.path}
      >
        {node.type === 'dir' ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className={`transition-transform ${open ? '' : '-rotate-90'}`}>
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="1.5" y="1" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
        <span className="truncate">{node.name}</span>
        {node.meta && (
          <span className="ml-auto flex items-center gap-1.5 text-[9px] shrink-0">
            {status && <span className={`${status.className} rounded border px-1 py-px leading-none`}>{status.label}</span>}
            {node.meta.additions > 0 && <span className="text-[#34d399]">+{node.meta.additions}</span>}
            {node.meta.deletions > 0 && <span className="text-[#f87171]">-{node.meta.deletions}</span>}
          </span>
        )}
      </button>
      {node.type === 'dir' && open && children.length > 0 && (
        <ul role="group">
          {children.map((child) => (
            <TreeItem key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function statusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'added':
      return { label: 'A', className: 'border-[#34d39955] text-[#34d399]' };
    case 'removed':
    case 'deleted':
      return { label: 'D', className: 'border-[#f8717155] text-[#f87171]' };
    case 'renamed':
      return { label: 'R', className: 'border-[#fbbf2455] text-[#fbbf24]' };
    case 'changed':
    case 'modified':
    default:
      return { label: 'M', className: 'border-accent/40 text-accent' };
  }
}
