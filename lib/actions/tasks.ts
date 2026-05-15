"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type { RuntimeKind, TaskType } from "@/lib/db/types";

export interface CreateTaskInput {
  projectId: string;
  type: TaskType;
  title: string;
  desc: string;
  autoplan: boolean;
  /** Required when autoplan is true; ignored otherwise. */
  planner: string | null;
  /** Required by the backend — the worker locks plan + implement to this. */
  runtime: RuntimeKind;
}

export type CreateTaskResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function createTaskAction(
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  try {
    const r = await callAuthed<{ success: boolean; id: string }>("/tasks", {
      method: "POST",
      body: input,
    });
    revalidatePath(`/projects/${input.projectId}`);
    revalidatePath("/inbox");
    return { ok: true, id: r.id };
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
