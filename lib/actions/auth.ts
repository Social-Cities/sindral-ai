"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ApiError, callAuthed, callPublic } from "@/lib/api";
import { clearSession, writeSession } from "@/lib/session";

export type AuthResult = { ok: true } | { ok: false; error: string };

interface AuthApiResponse {
  success: boolean;
  user?: { id: string; email: string | null };
  accessToken?: string;
  refreshToken?: string;
  requiresConfirmation?: boolean;
  error?: string;
}

async function exchange(
  path: string,
  email: string,
  password: string,
): Promise<AuthResult> {
  try {
    const r = await callPublic<AuthApiResponse>(path, {
      method: "POST",
      body: { email, password },
    });
    if (r.requiresConfirmation) {
      return { ok: false, error: "Check your email to confirm your account." };
    }
    if (!r.accessToken || !r.refreshToken) {
      return { ok: false, error: r.error ?? "Sign in failed" };
    }
    await writeSession({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Sign in failed";
    return { ok: false, error: message };
  }
}

export async function signInAction(
  email: string,
  password: string,
): Promise<AuthResult> {
  return exchange("/auth/signin", email, password);
}

export async function signUpAction(
  email: string,
  password: string,
): Promise<AuthResult> {
  return exchange("/auth/signup", email, password);
}

export async function signOutAction(): Promise<void> {
  try {
    await callAuthed("/auth/signout", { method: "POST", refreshOn401: false });
  } catch {
    // Even if the backend call fails, clear the cookie so the user is logged
    // out locally.
  }
  await clearSession();
  revalidatePath("/", "layout");
  redirect("/login");
}
