import "server-only";
import { clearSession, readSession, writeSession, type Session } from "./session";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RefreshResponse {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
}

async function refreshSession(refreshToken: string): Promise<Session | null> {
  const res = await fetch(`${BACKEND_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as RefreshResponse;
  if (!body.success || !body.accessToken || !body.refreshToken) return null;
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

interface CallOpts {
  method?: string;
  body?: unknown;
  // When true, attempts to refresh + retry once on a 401 from the backend.
  // Default true; turn off for the auth endpoints themselves.
  refreshOn401?: boolean;
}

async function rawFetch(
  path: string,
  accessToken: string | null,
  opts: CallOpts,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${BACKEND_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
}

export async function callAuthed<T>(path: string, opts: CallOpts = {}): Promise<T> {
  const session = await readSession();
  if (!session) throw new ApiError(401, "Not signed in");

  let res = await rawFetch(path, session.accessToken, opts);
  if (res.status === 401 && opts.refreshOn401 !== false) {
    const refreshed = await refreshSession(session.refreshToken);
    if (!refreshed) {
      await clearSession();
      throw new ApiError(401, "Session expired");
    }
    await writeSession(refreshed);
    res = await rawFetch(path, refreshed.accessToken, opts);
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof json.error === "string" ? json.error : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

export async function callPublic<T>(path: string, opts: CallOpts = {}): Promise<T> {
  const res = await rawFetch(path, null, { ...opts, refreshOn401: false });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof json.error === "string" ? json.error : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

export async function getCurrentUser(): Promise<{
  id: string;
  email: string | null;
} | null> {
  const session = await readSession();
  if (!session) return null;
  try {
    const r = await callAuthed<{
      success: boolean;
      user: { id: string; email: string | null };
    }>("/auth/me");
    return r.user;
  } catch {
    return null;
  }
}
