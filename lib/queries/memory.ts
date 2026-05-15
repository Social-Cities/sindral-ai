import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type { TaskMemory } from "@/lib/db/types";

export const getTaskMemory = cache(
  async (taskId: string): Promise<TaskMemory | null> => {
    try {
      const r = await callAuthed<{ memory: TaskMemory | null }>(
        `/tasks/${encodeURIComponent(taskId)}/memory`,
      );
      return r.memory;
    } catch {
      return null;
    }
  },
);
