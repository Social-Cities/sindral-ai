"use client";

import Link from "next/link";
import { Avatar } from "./atoms";
import { usePerson } from "./providers/people-context";
import type { ActivityItem } from "@/lib/data";

export function InboxView({
  activity,
  taskProjectMap,
}: {
  activity: ActivityItem[];
  taskProjectMap: Record<string, string>;
}) {
  return (
    <div className="content" data-screen-label="Inbox">
      <div className="page-head">
        <h1>Inbox</h1>
        <div className="page-sub">Things your agents and teammates need you to look at.</div>
      </div>
      <div className="feed">
        {activity.map((f) => (
          <FeedItem
            key={f.id}
            item={f}
            projectId={taskProjectMap[f.target] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function FeedItem({ item, projectId }: { item: ActivityItem; projectId: string | null }) {
  const person = usePerson(item.who);
  const href = projectId ? `/projects/${projectId}/tasks/${item.target}` : "#";
  return (
    <Link href={href} className="feed-item">
      <Avatar who={item.who} />
      <div className="feed-text">
        <strong>{person?.name}</strong>{" "}
        <span className="muted">{item.verb}</span>{" "}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)" }}>
          {item.target}
        </span>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{item.detail}</div>
      </div>
      <span className="feed-time">{item.t}</span>
    </Link>
  );
}
