import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type { ChatChannel, TaskConversationMessage } from "@/lib/db/types";

export const getTaskChat = cache(
  async (
    taskId: string,
    channel: ChatChannel,
  ): Promise<TaskConversationMessage[]> => {
    try {
      const r = await callAuthed<{ messages: TaskConversationMessage[] }>(
        `/tasks/${encodeURIComponent(taskId)}/chat?channel=${channel}`,
      );
      return r.messages;
    } catch {
      return [];
    }
  },
);
