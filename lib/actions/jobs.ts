"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";

export interface CancelJobInput {
  jobId: string;
  /** Used only for cache revalidation. */
  taskId?: string;
  projectId?: string;
}

export type CancelJobResult =
  | { ok: true }
  | { ok: false; error: string };

// Note: the backend cancels at the task workflow level (a job's lifetime is
// scoped to the workflow run); the workflow's terminal hooks mark the
// associated job rows as cancelled. We surface the affordance per-job
// because that's how the UI thinks about it.
export async function cancelJobAction(
  input: CancelJobInput,
): Promise<CancelJobResult> {
  try {
    await callAuthed<{ success: boolean }>(
      `/jobs/${encodeURIComponent(input.jobId)}/cancel`,
      { method: "POST" },
    );
    if (input.projectId && input.taskId) {
      revalidatePath(`/projects/${input.projectId}/tasks/${input.taskId}`);
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
