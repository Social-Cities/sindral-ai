import { notFound } from "next/navigation";
import { CodeView } from "@/components/code-view";
import { getProject } from "@/lib/queries/projects";

export default async function CodePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = await getProject(projectId);
  if (!project) notFound();
  return <CodeView project={project} />;
}
