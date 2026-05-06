"use client";

import { useEffect, useState } from "react";
import { WorkerPill } from "./atoms";
import { TEAMMATES } from "@/lib/data";

export function WorkersStrip() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 1500);
    return () => clearInterval(i);
  }, []);
  const working = TEAMMATES.filter((a) => a.status === "working");
  return (
    <div className="workers-strip">
      <span style={{ color: "var(--text-muted)" }}>
        <span style={{ display: "inline-block", width: 6, height: 6, background: "#4a8a5a", borderRadius: 50, marginRight: 6, verticalAlign: "middle" }} />
        {working.length} agents active · 5 sandboxes available
      </span>
      <div style={{ flex: 1 }} />
      {working.map((a, i) => (
        <WorkerPill key={a.id} agent={a} progress={0.3 + 0.3 * Math.sin(tick * 0.4 + i)} />
      ))}
    </div>
  );
}
