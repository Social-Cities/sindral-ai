"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type { Project } from "@/lib/db/types";

export interface CreateProjectInput {
  name: string;
  repo: string | null;
  emoji?: string;
  description?: string | null;
}

export interface UpdateProjectInput {
  id: string;
  name?: string;
  repo?: string | null;
  emoji?: string;
  description?: string | null;
  active?: boolean;
  /** Pass null to clear, an id to attach. Validated server-side against
   *  the caller's owned github_installations rows. */
  githubInstallationId?: string | null;
}

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: string };

export type UpdateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: string };

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

export async function createProjectAction(
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  try {
    const r = await callAuthed<{ success: boolean; project: Project }>(
      "/projects",
      { method: "POST", body: input },
    );
    revalidatePath("/", "layout");
    return { ok: true, project: r.project };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function updateProjectAction(
  input: UpdateProjectInput,
): Promise<UpdateProjectResult> {
  try {
    const { id, ...patch } = input;
    const r = await callAuthed<{ success: boolean; project: Project }>(
      `/projects/${encodeURIComponent(id)}`,
      { method: "PATCH", body: patch },
    );
    revalidatePath("/", "layout");
    revalidatePath(`/projects/${id}`);
    return { ok: true, project: r.project };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
