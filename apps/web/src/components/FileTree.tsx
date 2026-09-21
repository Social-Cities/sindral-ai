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
    <ul role="tree" aria-label="Changed files" className="text-xs font-mono">
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

  return (
    <li role="treeitem" aria-expanded={node.type === 'dir' ? open : undefined} aria-selected={node.type === 'file' ? isSelected : undefined}>
      <button
        type="button"
        onClick={() => (node.type === 'dir' ? setOpen((o) => !o) : onSelect(node.path))}
        className={`w-full text-left flex items-center gap-1.5 py-0.5 pr-2 rounded transition-colors ${
          isSelected ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-secondary-foreground'
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
          <span className="ml-auto flex items-center gap-1 text-[9px] shrink-0">
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
