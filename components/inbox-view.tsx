"use client";

import { Avatar } from "./atoms";
import { ACTIVITY, HUMANS, TEAMMATES } from "@/lib/data";

export function InboxView({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  return (
    <div className="content" data-screen-label="Inbox">
      <div className="page-head">
        <h1>Inbox</h1>
        <div className="page-sub">Things your agents and teammates need you to look at.</div>
      </div>
      <div className="feed">
        {ACTIVITY.map((f) => {
          const a = TEAMMATES.find((x) => x.id === f.who);
          const h = HUMANS.find((x) => x.id === f.who);
          const name = a?.name || h?.name;
          return (
            <div key={f.id} className="feed-item" onClick={() => onOpenTask(f.target)}>
              <Avatar who={f.who} />
              <div className="feed-text">
                <strong>{name}</strong> <span className="muted">{f.verb}</span>{" "}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)" }}>{f.target}</span>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {f.detail}
                </div>
              </div>
              <span className="feed-time">{f.t}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
