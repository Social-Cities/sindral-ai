"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type { TaskType } from "@/lib/db/types";

export interface CreateTaskInput {
  projectId: string;
  type: TaskType;
  title: string;
  desc: string;
  autoplan: boolean;
  planner: string;
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
