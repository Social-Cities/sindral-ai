"use client";

import { useEffect, useState } from "react";
import { Sidebar, type SidebarView } from "./sidebar";
import { Topbar } from "./topbar";
import { ProjectView } from "./project-view";
import { InboxView } from "./inbox-view";
import { WorkersStrip } from "./workers-strip";
import { TaskDetail } from "./task-detail";
import { ImportModal, NewTaskModal } from "./modals";
import { PROJECTS } from "@/lib/data";

const DEFAULTS = {
  accent: "#4a8a5a",
  theme: "light" as "light" | "dark",
};

export function App() {
  const [view, setView] = useState<SidebarView>("project");
  const [project, setProject] = useState("p1");
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(DEFAULTS.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = "cozy";
    document.documentElement.style.setProperty("--accent", DEFAULTS.accent);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowNewTask(false);
        setShowImport(false);
      }
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === "c" && !showNewTask && tag !== "INPUT" && tag !== "TEXTAREA") {
        setShowNewTask(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showNewTask]);

  const proj = PROJECTS.find((p) => p.id === project);
  let crumbs: string[] = ["Agatha"];
  if (view === "project") {
    crumbs = ["Agatha", proj?.name || ""];
    if (openTask) crumbs.push(openTask);
  } else if (view === "inbox") crumbs = ["Agatha", "Inbox"];
  else if (view === "myissues") crumbs = ["Agatha", "My tasks"];
  else if (view === "activity") crumbs = ["Agatha", "Activity"];

  return (
    <div className="app" data-sidebar="default">
      <Sidebar
        view={view}
        setView={(v) => {
          setView(v);
          setOpenTask(null);
        }}
        project={project}
        setProject={setProject}
        projects={PROJECTS}
        onImport={() => setShowImport(true)}
      />
      <main className="main">
        <Topbar
          crumbs={crumbs}
          onNewTask={() => setShowNewTask(true)}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {openTask ? (
            <TaskDetail taskId={openTask} onBack={() => setOpenTask(null)} sidebarLayout="default" />
          ) : view === "project" ? (
            <ProjectView project={project} onOpenTask={setOpenTask} />
          ) : view === "inbox" ? (
            <InboxView
              onOpenTask={(id) => {
                setView("project");
                setOpenTask(id);
              }}
            />
          ) : (
            <div className="empty">
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 26, marginBottom: 6 }}>
                  {view === "myissues" ? "My tasks" : "Activity"}
                </div>
                <div>Coming up next.</div>
              </div>
            </div>
          )}
        </div>
        <WorkersStrip />
      </main>

      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} onCreate={() => setShowNewTask(false)} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}
