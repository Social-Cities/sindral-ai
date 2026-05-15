"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type { RuntimeKind } from "@/lib/db/types";

export interface AssignWorkerInput {
  taskId: string;
  agentId: string;
  /** Optional: overrides the runtime locked at task creation. */
  runtime?: RuntimeKind;
  projectId?: string;
}

export type AssignWorkerResult =
  | { ok: true }
  | { ok: false; error: string };

export async function assignWorkerAction(
  input: AssignWorkerInput,
): Promise<AssignWorkerResult> {
  try {
    await callAuthed<{ success: boolean }>(
      `/tasks/${encodeURIComponent(input.taskId)}/assign`,
      {
        method: "POST",
        body: { agentId: input.agentId, runtime: input.runtime },
      },
    );
    if (input.projectId) {
      revalidatePath(`/projects/${input.projectId}/tasks/${input.taskId}`);
      revalidatePath(`/projects/${input.projectId}`);
    }
    return { ok: true };
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
