import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/task-detail";
import {
  getPRFiles,
  getPRMessages,
  getPlanMessages,
  getTask,
  getTaskPlan,
} from "@/lib/queries/tasks";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;
  const task = await getTask(taskId);
  if (!task || task.projectId !== projectId) notFound();

  const [plan, planMessages, prFiles, prMessages] = await Promise.all([
    getTaskPlan(taskId),
    getPlanMessages(taskId),
    getPRFiles(taskId),
    getPRMessages(taskId),
  ]);

  return (
    <TaskDetail
      task={task}
      plan={plan}
      planMessages={planMessages}
      prFiles={prFiles}
      prMessages={prMessages}
      backHref={`/projects/${projectId}`}
    />
  );
}
