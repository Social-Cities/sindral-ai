"use client";

import { useMemo, useState } from "react";
import { I } from "./icons";
import type { Project } from "@/lib/data";
import { FS, getFile, type FsDir, type FsNode } from "@/lib/fs";

function fileIcon(name: string): { ico: string; color: string } {
  if (name.endsWith(".rs")) return { ico: "rs", color: "#c98a2b" };
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return { ico: "ts", color: "#4a7fc4" };
  if (name.endsWith(".js") || name.endsWith(".jsx")) return { ico: "js", color: "#c98a2b" };
  if (name.endsWith(".json")) return { ico: "{}", color: "#9658c4" };
  if (name.endsWith(".toml")) return { ico: "t", color: "#c45858" };
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return { ico: "y", color: "#9658c4" };
  if (name.endsWith(".md")) return { ico: "md", color: "#6b6a64" };
  if (name.endsWith(".sql")) return { ico: "sq", color: "#4a8a5a" };
  if (name.endsWith(".html")) return { ico: "<>", color: "#c98a2b" };
  return { ico: "·", color: "var(--text-faint)" };
}

function FileSizeLabel({ s }: { s: string }) {
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-faint)", marginLeft: "auto" }}>{s}</span>
  );
}

function TreeNode({
  name,
  node,
  path,
  depth,
  openMap,
  setOpenMap,
  selected,
  setSelected,
}: {
  name: string;
  node: FsNode;
  path: string;
  depth: number;
  openMap: Record<string, boolean>;
  setOpenMap: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  selected: string;
  setSelected: (p: string) => void;
}) {
  if (node.kind === "file") {
    const fi = fileIcon(name);
    const isSel = selected === path;
    return (
      <div
        className={`tree-row tree-file ${isSel ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setSelected(path)}
      >
        <span className="tree-icon file-ico" style={{ color: fi.color }}>{fi.ico}</span>
        <span className="tree-name">{name}</span>
        {node.highlight && (
          <span className="tree-task-tag" title={`Modified by ${node.highlight}`}>{node.highlight}</span>
        )}
        <FileSizeLabel s={node.size} />
      </div>
    );
  }
  const isOpen = openMap[path] !== false;
  const childKeys = Object.keys(node.children).sort((a, b) => {
    const ad = node.children[a].kind === "dir" ? 0 : 1;
    const bd = node.children[b].kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.localeCompare(b);
  });
  return (
    <>
      <div
        className="tree-row tree-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpenMap((m) => ({ ...m, [path]: !isOpen }))}
      >
        <span className="tree-chev">{isOpen ? <I.chevD /> : <I.chevR />}</span>
        <span className="tree-name" style={{ fontWeight: 500 }}>{name}</span>
      </div>
      {isOpen &&
        childKeys.map((k) => (
          <TreeNode
            key={k}
            name={k}
            node={node.children[k]}
            path={path ? path + "/" + k : k}
            depth={depth + 1}
            openMap={openMap}
            setOpenMap={setOpenMap}
            selected={selected}
            setSelected={setSelected}
          />
        ))}
    </>
  );
}

// Single-pass tokenizer to avoid nested-replacement corruption.
function highlightCode(text: string, lang: string): string {
  if (!text) return "";
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const wrap = (cls: string, s: string) => `<span class="${cls}">${escape(s)}</span>`;

  const cLine = lang === "rust" || lang === "tsx" || lang === "ts" || lang === "js" || lang === "json";
  const cHash = lang === "toml" || lang === "yaml";
  const cDash = lang === "sql";

  const kw: Record<string, string[]> = {
    rust: ["fn", "let", "mut", "pub", "use", "async", "await", "impl", "struct", "enum", "match", "if", "else", "for", "while", "loop", "return", "self", "Self", "crate", "mod", "as", "in", "where", "ref", "move", "dyn", "trait", "const", "static", "type", "unsafe"],
    ts: ["function", "let", "const", "var", "return", "if", "else", "for", "while", "class", "interface", "type", "export", "import", "from", "async", "await", "new", "this", "public", "private", "protected", "static", "extends", "implements"],
    js: ["function", "let", "const", "var", "return", "if", "else", "for", "while", "class", "export", "import", "from", "async", "await", "new", "this", "of", "in"],
    sql: ["CREATE", "TABLE", "REPLACE", "FUNCTION", "RETURNS", "BEGIN", "END", "LANGUAGE", "TRIGGER", "AFTER", "INSERT", "ON", "FOR", "EACH", "ROW", "WHEN", "EXECUTE", "PERFORM", "SELECT", "FROM", "WHERE"],
    toml: [],
    yaml: [],
  };
  const ks = kw[lang === "tsx" ? "ts" : lang] || [];
  const kwSet = new Set(ks);

  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text.slice(i, i + 2);
    if (cLine && c2 === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += wrap("hl-c", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (cLine && c2 === "//") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += wrap("hl-c", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (cHash && c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += wrap("hl-c", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (cDash && c2 === "--") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += wrap("hl-c", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        if (text[j] === "\n") break;
        j++;
      }
      out += wrap("hl-s", text.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (kwSet.has(word)) out += wrap("hl-k", word);
      else out += escape(word);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(text[j])) j++;
      out += wrap("hl-n", text.slice(i, j));
      i = j;
      continue;
    }
    out += escape(c);
    i++;
  }
  return out;
}

function CodeViewer({ path }: { path: string }) {
  const file = getFile(path);
  const html = useMemo(() => (file ? highlightCode(file.text || "", file.lang || "") : ""), [path, file]);

  if (!file) {
    return (
      <div className="code-empty">
        <div style={{ textAlign: "center", maxWidth: 320 }}>
          <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 22, marginBottom: 6 }}>Pick a file</div>
          <div style={{ color: "var(--text-muted)", fontSize: 13.5 }}>Browse the source tree on the left, or use ⌘P to open by path.</div>
        </div>
      </div>
    );
  }
  const lines = (file.text || "").split("\n");
  const htmlLines = html.split("\n");
  const segs = path.split("/");
  return (
    <div className="code-viewer">
      <div className="code-head">
        <span className="code-path">
          {segs.map((s, i) => (
            <span key={i}>
              {i > 0 && <span style={{ color: "var(--text-faint)", margin: "0 4px" }}>/</span>}
              <span style={{ color: i === segs.length - 1 ? "var(--text)" : "var(--text-muted)" }}>{s}</span>
            </span>
          ))}
        </span>
        {file.highlight && (
          <span className="code-task-tag" title={`Recently changed by ${file.highlight}`}>
            <I.branch />
            {file.highlight}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)" }}>
          {lines.length} lines · {file.size}
        </span>
        <button className="btn ghost sm"><I.sparkle />Ask Iris</button>
        <button className="btn ghost sm"><I.github />Open</button>
      </div>
      <div className="code-body">
        <pre className="code-pre">
          {htmlLines.map((ln, i) => (
            <div key={i} className="code-line">
              <span className="code-num">{i + 1}</span>
              <span className="code-text" dangerouslySetInnerHTML={{ __html: ln || " " }} />
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function CodeView({ project }: { project: Project }) {
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({ server: true, "server/src": true });
  const [selected, setSelected] = useState("server/src/queue/mod.rs");
  const rootKeys = Object.keys(FS).sort((a, b) => {
    const ad = FS[a].kind === "dir" ? 0 : 1;
    const bd = FS[b].kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.localeCompare(b);
  });
  return (
    <div className="code-layout" data-screen-label="Project — Code">
      <div className="code-tree">
        <div className="code-tree-head">
          <I.github />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500 }}>
            {project.repo ?? "No repo connected"}
          </span>
          <span
            className="muted"
            style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <I.branch />main
          </span>
        </div>
        <div className="code-tree-search">
          <I.search />
          <input placeholder="Find file… ⌘P" />
        </div>
        <div className="code-tree-list">
          {rootKeys.map((k) => (
            <TreeNode
              key={k}
              name={k}
              node={FS[k]}
              path={k}
              depth={0}
              openMap={openMap}
              setOpenMap={setOpenMap}
              selected={selected}
              setSelected={setSelected}
            />
          ))}
        </div>
      </div>
      <CodeViewer path={selected} />
    </div>
  );
}

// keep FsDir referenced so TS doesn't complain about unused export-only types
export type _Unused = FsDir;
