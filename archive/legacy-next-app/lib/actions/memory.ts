"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type { TaskMemory } from "@/lib/db/types";

export interface UpdateTaskMemoryInput {
  taskId: string;
  rollupMarkdown: string;
  projectId?: string;
}

export type UpdateTaskMemoryResult =
  | { ok: true; memory: TaskMemory }
  | { ok: false; error: string };

export async function updateTaskMemoryAction(
  input: UpdateTaskMemoryInput,
): Promise<UpdateTaskMemoryResult> {
  try {
    const r = await callAuthed<{ success: boolean; memory: TaskMemory }>(
      `/tasks/${encodeURIComponent(input.taskId)}/memory`,
      {
        method: "PATCH",
        body: { rollupMarkdown: input.rollupMarkdown },
      },
    );
    if (input.projectId) {
      revalidatePath(`/projects/${input.projectId}/tasks/${input.taskId}`);
    }
    return { ok: true, memory: r.memory };
  } catch (err) {
    const message =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Request failed";
    return { ok: false, error: message };
  }
}
