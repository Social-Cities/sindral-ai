"use server";

import { revalidatePath } from "next/cache";
import { ApiError, callAuthed } from "@/lib/api";

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

// Returns a URL on github.com that the user should be navigated to in order
// to install the App. The URL embeds a signed state token so the install
// callback can attribute the resulting installation back to the user.
export async function getGithubInstallStartUrl(): Promise<
  { ok: true; url: string } | { ok: false; error: string }
> {
  try {
    const r = await callAuthed<{ success: boolean; url: string }>(
      "/api/github/installations/start",
    );
    return { ok: true, url: r.url };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function disconnectGithubInstallationAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await callAuthed(`/api/github/installations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    revalidatePath("/settings/github");
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
