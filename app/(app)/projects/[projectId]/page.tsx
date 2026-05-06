import { notFound } from "next/navigation";
import { ProjectView } from "@/components/project-view";
import { getProject } from "@/lib/queries/projects";
import { getTasksForProject } from "@/lib/queries/tasks";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, tasks] = await Promise.all([
    getProject(projectId),
    getTasksForProject(projectId),
  ]);
  if (!project) notFound();
  return <ProjectView project={project} tasks={tasks} />;
}
