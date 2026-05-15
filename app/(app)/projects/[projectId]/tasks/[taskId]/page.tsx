import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/task-detail";
import {
  getPRFiles,
  getPRMessages,
  getPlanMessages,
  getTask,
  getTaskPlan,
} from "@/lib/queries/tasks";
import { getTaskChat } from "@/lib/queries/chat";
import { getTaskJobs } from "@/lib/queries/jobs";
import { getTaskMemory } from "@/lib/queries/memory";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;
  const task = await getTask(taskId);
  if (!task || task.projectId !== projectId) notFound();

  // Fan out reads in parallel — each cache()-wrapped query handles its own
  // 401 + error fallback.
  const [plan, planMessages, prFiles, prMessages, planChat, implChat, jobs, memory] =
    await Promise.all([
      getTaskPlan(taskId),
      getPlanMessages(taskId),
      getPRFiles(taskId),
      getPRMessages(taskId),
      getTaskChat(taskId, "plan"),
      getTaskChat(taskId, "implementation"),
      getTaskJobs(taskId),
      getTaskMemory(taskId),
    ]);

  // The Chat tab filters by channel client-side; merging here keeps the
  // wire format and the prop tree small.
  const conversation = [...planChat, ...implChat];

  return (
    <TaskDetail
      task={task}
      projectId={projectId}
      plan={plan}
      planMessages={planMessages}
      prFiles={prFiles}
      prMessages={prMessages}
      conversation={conversation}
      jobs={jobs}
      memory={memory}
      backHref={`/projects/${projectId}`}
    />
  );
}
