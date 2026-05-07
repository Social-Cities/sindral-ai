"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";
import type {
  AgentRole,
  AgentStatus,
  PersonaPresetId,
  Teammate,
} from "@/lib/db/types";

export interface CreateTeammateInput {
  name: string;
  role: AgentRole;
  model: string;
  hue: number;
  status?: AgentStatus;
  personaPreset: PersonaPresetId;
  /** Required when personaPreset === "custom". */
  personaPrompt?: string;
}

export interface UpdateTeammateInput {
  id: string;
  name?: string;
  role?: AgentRole;
  model?: string;
  hue?: number;
  status?: AgentStatus;
  personaPreset?: PersonaPresetId;
  personaPrompt?: string;
}

export type TeammateResult =
  | { ok: true; teammate: Teammate }
  | { ok: false; error: string };

export type DeleteTeammateResult = { ok: true } | { ok: false; error: string };

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

export async function createTeammateAction(
  input: CreateTeammateInput,
): Promise<TeammateResult> {
  try {
    const r = await callAuthed<{ success: boolean; teammate: Teammate }>(
      "/teammates",
      { method: "POST", body: input },
    );
    revalidatePath("/", "layout");
    return { ok: true, teammate: r.teammate };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function updateTeammateAction(
  input: UpdateTeammateInput,
): Promise<TeammateResult> {
  try {
    const { id, ...patch } = input;
    const r = await callAuthed<{ success: boolean; teammate: Teammate }>(
      `/teammates/${encodeURIComponent(id)}`,
      { method: "PATCH", body: patch },
    );
    revalidatePath("/", "layout");
    return { ok: true, teammate: r.teammate };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function deleteTeammateAction(
  id: string,
): Promise<DeleteTeammateResult> {
  try {
    await callAuthed<{ success: boolean }>(
      `/teammates/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
