import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type { Project, ProjectWithCounts } from "@/lib/db/types";

export const getProjectsWithCounts = cache(
  async (): Promise<ProjectWithCounts[]> => {
    const r = await callAuthed<{ projects: ProjectWithCounts[] }>("/projects");
    return r.projects;
  },
);

export const getProject = cache(async (id: string): Promise<Project | null> => {
  try {
    const r = await callAuthed<{ project: Project }>(
      `/projects/${encodeURIComponent(id)}`,
    );
    return r.project;
  } catch {
    return null;
  }
});
