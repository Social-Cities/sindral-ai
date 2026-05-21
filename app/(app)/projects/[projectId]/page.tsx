import { notFound } from "next/navigation";
import { ProjectView } from "@/components/project-view";
import { getProject } from "@/lib/queries/projects";
import { getTasksForProject } from "@/lib/queries/tasks";
import { getGithubInstallations } from "@/lib/queries/github";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, tasks, githubInstallations] = await Promise.all([
    getProject(projectId),
    getTasksForProject(projectId),
    // Fetched here so the settings modal can render the dropdown without a
    // second roundtrip on open. Will be empty when the user hasn't
    // connected anything yet.
    getGithubInstallations().catch(() => []),
  ]);
  if (!project) notFound();
  return (
    <ProjectView
      project={project}
      tasks={tasks}
      githubInstallations={githubInstallations}
    />
  );
}
