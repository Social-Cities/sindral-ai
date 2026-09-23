"use client";

import { Fragment } from "react";
import { I } from "./icons";

export function Topbar({
  crumbs,
  onNewTask,
  theme,
  onToggleTheme,
}: {
  crumbs: string[];
  onNewTask: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="crumb-sep">/</span>}
            <span className={i === crumbs.length - 1 ? "crumb-active" : ""}>{c}</span>
          </Fragment>
        ))}
      </div>
      <div className="topbar-spacer" />
      <div className="search">
        <I.search />
        <input placeholder="Search…" />
        <span className="kbd-hint">⌘K</span>
      </div>
      <button className="btn ghost sm" title="Filter">
        <I.filter />
        Filter
      </button>
      <button
        className="btn ghost sm"
        title={theme === "light" ? "Switch to dark" : "Switch to light"}
        onClick={onToggleTheme}
      >
        {theme === "light" ? <I.moon /> : <I.sun />}
      </button>
      <button className="btn primary sm" onClick={onNewTask}>
        <I.plus />
        New task
        <span className="kbd">C</span>
      </button>
    </div>
  );
}
