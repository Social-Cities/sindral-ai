"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type { ChatChannel, TaskConversationMessage } from "@/lib/db/types";

export interface SendChatMessageInput {
  taskId: string;
  channel: ChatChannel;
  message: string;
  /** Optional pointer to the project so we can revalidate that view too. */
  projectId?: string;
}

export type SendChatMessageResult =
  | { ok: true; message: TaskConversationMessage }
  | { ok: false; error: string };

export async function sendChatMessageAction(
  input: SendChatMessageInput,
): Promise<SendChatMessageResult> {
  try {
    const r = await callAuthed<{
      success: boolean;
      message: TaskConversationMessage;
    }>(`/tasks/${encodeURIComponent(input.taskId)}/chat`, {
      method: "POST",
      body: { channel: input.channel, message: input.message },
    });
    if (input.projectId) {
      revalidatePath(`/projects/${input.projectId}/tasks/${input.taskId}`);
    }
    return { ok: true, message: r.message };
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
