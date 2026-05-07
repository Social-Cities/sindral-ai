"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, type SidebarView } from "./sidebar";
import { Topbar } from "./topbar";
import { WorkersStrip } from "./workers-strip";
import { NewProjectModal, NewTaskModal, TeammatesModal } from "./modals";
import type { Project, ProjectWithCounts } from "@/lib/data";

const ACCENT = "#4a8a5a";

interface ParsedRoute {
  view: SidebarView;
  projectId: string | null;
  taskId: string | null;
  isCode: boolean;
}

function parsePath(path: string): ParsedRoute {
  if (path.startsWith("/inbox")) return { view: "inbox", projectId: null, taskId: null, isCode: false };
  if (path.startsWith("/my-tasks")) return { view: "myissues", projectId: null, taskId: null, isCode: false };
  if (path.startsWith("/activity")) return { view: "activity", projectId: null, taskId: null, isCode: false };
  const m = path.match(/^\/projects\/([^/]+)(\/tasks\/([^/]+))?(\/code)?/);
  if (m) {
    return {
      view: "project",
      projectId: m[1],
      taskId: m[3] ?? null,
      isCode: Boolean(m[4]),
    };
  }
  return { view: "inbox", projectId: null, taskId: null, isCode: false };
}

export function AppShell({
  projects,
  currentUserEmail,
  children,
}: {
  projects: ProjectWithCounts[];
  currentUserEmail: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/inbox";
  const route = useMemo(() => parsePath(pathname), [pathname]);
  const project: Project | null = useMemo(
    () => projects.find((p) => p.id === route.projectId) ?? null,
    [projects, route.projectId],
  );

  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showNewTask, setShowNewTask] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showTeammates, setShowTeammates] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = "cozy";
    document.documentElement.style.setProperty("--accent", ACCENT);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowNewTask(false);
        setShowNewProject(false);
        setShowTeammates(false);
      }
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === "c" && !showNewTask && tag !== "INPUT" && tag !== "TEXTAREA") {
        setShowNewTask(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showNewTask]);

  const crumbs: string[] = ["Agatha"];
  if (route.view === "inbox") crumbs.push("Inbox");
  else if (route.view === "myissues") crumbs.push("My tasks");
  else if (route.view === "activity") crumbs.push("Activity");
  else if (route.view === "project" && project) {
    crumbs.push(project.name);
    if (route.taskId) crumbs.push(route.taskId);
    else if (route.isCode) crumbs.push("Code");
  }

  return (
    <div className="app" data-sidebar="default">
      <Sidebar
        view={route.view}
        projectId={route.projectId}
        projects={projects}
        currentUserEmail={currentUserEmail}
        onNewProject={() => setShowNewProject(true)}
        onManageTeammates={() => setShowTeammates(true)}
      />
      <main className="main">
        <Topbar
          crumbs={crumbs}
          onNewTask={() => setShowNewTask(true)}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>
        <WorkersStrip />
      </main>

      {showNewTask && projects.length > 0 && (
        <NewTaskModal
          projects={projects}
          defaultProjectId={project?.id ?? projects[0]?.id ?? null}
          onClose={() => setShowNewTask(false)}
        />
      )}
      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} />
      )}
      {showTeammates && (
        <TeammatesModal onClose={() => setShowTeammates(false)} />
      )}
    </div>
  );
}
