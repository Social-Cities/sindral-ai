"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import { I } from "./icons";
import {
  TASK_TYPES,
  TASK_STATES,
  type Teammate,
  type TaskType,
  type TaskState,
} from "@/lib/data";
import { usePerson } from "./providers/people-context";

type AvatarSize = "sm" | "md" | "lg" | "xl";

export function Avatar({
  who,
  size = "md",
  showStatus = false,
}: {
  who: string;
  size?: AvatarSize;
  showStatus?: boolean;
}) {
  const entity = usePerson(who);
  if (!entity) return null;
  const isAgent = "role" in entity;
  const sizeClass = size === "sm" ? "sm" : size === "lg" ? "lg" : size === "xl" ? "xl" : "";

  const initials = isAgent
    ? entity.name[0]
    : entity.short || entity.name[0];

  const bg = isAgent
    ? `radial-gradient(circle at 30% 25%, oklch(0.78 0.16 ${entity.hue}), oklch(0.52 0.18 ${(entity.hue + 30) % 360}))`
    : `oklch(0.55 0.13 ${entity.hue})`;

  return (
    <div className={`avatar ${sizeClass}`} style={{ background: bg }} title={entity.name}>
      <span>{initials}</span>
      {showStatus && isAgent && <span className={`tm-dot ${entity.status}`} />}
    </div>
  );
}

export function TypePill({ type }: { type: TaskType }) {
  const t = TASK_TYPES[type];
  if (!t) return null;
  return (
    <span className="task-type-pill" style={{ ["--type-color" as string]: t.color } as React.CSSProperties}>
      {t.label}
    </span>
  );
}

export function StatusPill({ state, withLabel = true }: { state: TaskState; withLabel?: boolean }) {
  const s = TASK_STATES[state];
  if (!s) return null;
  const fill = state === "merged" || state === "planReady" || state === "prOpen" ? s.color : "transparent";
  return (
    <span
      className={`task-status s-${state}`}
      style={{
        ["--status-color" as string]: s.color,
        ["--status-fill" as string]: fill,
      } as React.CSSProperties}
    >
      {withLabel && s.label}
    </span>
  );
}

// ── Tiny markdown renderer (#, ##, ###, paragraphs, lists, blockquotes,
// fenced code, [[file refs]], `code`, **bold**, *italic*) ────────────────────
type Block =
  | { type: "h1" | "h2" | "h3" | "p" | "quote"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "code"; lang: string; text: string };

export function renderMarkdown(md: string): Block[] {
  if (!md) return [];
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      const m = line.match(/^(#{1,3})\s+(.*)$/)!;
      blocks.push({ type: ("h" + m[1].length) as "h1" | "h2" | "h3", text: m[2] });
      i++;
      continue;
    }
    if (/^>\s/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^>\s/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !lines[i].startsWith("```")
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: paraLines.join(" ") });
  }
  return blocks;
}

export function renderInline(text: string, key: string | number = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const tokenRe = /(\[\[([^\]]+)\]\])|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/;
  while (rest.length) {
    const m = rest.match(tokenRe);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index! > 0) out.push(rest.slice(0, m.index));
    if (m[2] !== undefined) {
      out.push(
        <a key={`${key}-${n++}`} className="file-ref" href="#">
          <I.file /> {m[2]}
        </a>
      );
    } else if (m[4] !== undefined) {
      out.push(<code key={`${key}-${n++}`}>{m[4]}</code>);
    } else if (m[6] !== undefined) {
      out.push(<strong key={`${key}-${n++}`}>{m[6]}</strong>);
    } else if (m[8] !== undefined) {
      out.push(<em key={`${key}-${n++}`}>{m[8]}</em>);
    }
    rest = rest.slice(m.index! + m[0].length);
  }
  return out.map((c, idx) =>
    typeof c === "string" ? (
      <Fragment key={`${key}-s${idx}`}>{c}</Fragment>
    ) : (
      <Fragment key={`${key}-x${idx}`}>{c}</Fragment>
    )
  );
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1;
        const cursor = streaming && isLast;
        if (b.type === "h1")
          return (
            <h1 key={i}>
              {renderInline(b.text, i)}
              {cursor && <span className="streaming-cursor" />}
            </h1>
          );
        if (b.type === "h2")
          return (
            <h2 key={i}>
              {renderInline(b.text, i)}
              {cursor && <span className="streaming-cursor" />}
            </h2>
          );
        if (b.type === "h3")
          return (
            <h3 key={i}>
              {renderInline(b.text, i)}
              {cursor && <span className="streaming-cursor" />}
            </h3>
          );
        if (b.type === "p")
          return (
            <p key={i}>
              {renderInline(b.text, i)}
              {cursor && <span className="streaming-cursor" />}
            </p>
          );
        if (b.type === "ul")
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {renderInline(it, `${i}-${j}`)}
                  {cursor && j === b.items.length - 1 && <span className="streaming-cursor" />}
                </li>
              ))}
            </ul>
          );
        if (b.type === "ol")
          return (
            <ol key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {renderInline(it, `${i}-${j}`)}
                  {cursor && j === b.items.length - 1 && <span className="streaming-cursor" />}
                </li>
              ))}
            </ol>
          );
        if (b.type === "quote")
          return (
            <blockquote key={i}>
              {renderInline(b.text, i)}
              {cursor && <span className="streaming-cursor" />}
            </blockquote>
          );
        if (b.type === "code")
          return (
            <pre key={i}>
              <code>
                {b.text}
                {cursor && <span className="streaming-cursor" />}
              </code>
            </pre>
          );
        return null;
      })}
    </div>
  );
}

export function WorkerPill({ agent, progress = 0.4 }: { agent: Teammate; progress?: number }) {
  return (
    <div className="worker-pill">
      <Avatar who={agent.id} size="sm" showStatus />
      <span>{agent.name}</span>
      <span className="wp-task">{agent.task}</span>
      <div className="wp-prog" title={`${Math.round(progress * 100)}%`}>
        <div className="wp-prog-fill" style={{ width: progress * 100 + "%" }} />
      </div>
    </div>
  );
}
