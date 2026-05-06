import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type {
  DiffFile,
  PlanMessage,
  Task,
  TaskPlan,
} from "@/lib/db/types";

export const getTasksForProject = cache(
  async (projectId: string): Promise<Task[]> => {
    const r = await callAuthed<{ tasks: Task[] }>(
      `/projects/${encodeURIComponent(projectId)}/tasks`,
    );
    return r.tasks;
  },
);

export const getTask = cache(async (id: string): Promise<Task | null> => {
  try {
    const r = await callAuthed<{ task: Task }>(`/tasks/${encodeURIComponent(id)}`);
    return r.task;
  } catch {
    return null;
  }
});

export const getTaskPlan = cache(
  async (taskId: string): Promise<TaskPlan | null> => {
    const r = await callAuthed<{ plan: TaskPlan | null }>(
      `/tasks/${encodeURIComponent(taskId)}/plan`,
    );
    return r.plan;
  },
);

export const getPlanMessages = cache(
  async (taskId: string): Promise<PlanMessage[]> => {
    const r = await callAuthed<{ messages: PlanMessage[] }>(
      `/tasks/${encodeURIComponent(taskId)}/plan-messages`,
    );
    return r.messages;
  },
);

export const getPRMessages = cache(
  async (taskId: string): Promise<PlanMessage[]> => {
    const r = await callAuthed<{ messages: PlanMessage[] }>(
      `/tasks/${encodeURIComponent(taskId)}/pr-messages`,
    );
    return r.messages;
  },
);

export const getPRFiles = cache(
  async (taskId: string): Promise<DiffFile[]> => {
    const r = await callAuthed<{ files: DiffFile[] }>(
      `/tasks/${encodeURIComponent(taskId)}/pr-files`,
    );
    return r.files;
  },
);
