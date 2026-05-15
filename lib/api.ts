import "server-only";
import {
  clearSession,
  readCurrentOrgId,
  readSession,
  writeCurrentOrgId,
  writeSession,
  type Session,
} from "./session";

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
  // Extra headers (e.g. Idempotency-Key).
  headers?: Record<string, string>;
  // Skip the x-org-id header. Use for org-management endpoints (/orgs,
  // /invitations/*) and auth endpoints that are not org-scoped.
  skipOrgHeader?: boolean;
}

async function rawFetch(
  path: string,
  accessToken: string | null,
  orgId: string | null,
  opts: CallOpts,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (orgId && !opts.skipOrgHeader) headers["x-org-id"] = orgId;
  return fetch(`${BACKEND_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
}

interface OrganizationMembershipResponse {
  success: boolean;
  organizations?: Array<{
    role: string;
    org: { id: string; name: string; slug: string; createdAt: string };
  }>;
}

// Reads the active org from the cookie. Cookies can't be written from
// Server Components, so this is strictly read-only — the cookie is
// persisted by the Server Actions in lib/actions/orgs.ts (and after sign-
// in, by ensureCurrentOrgCookie below).
async function readActiveOrgId(): Promise<string | null> {
  return readCurrentOrgId();
}

// Picks the user's first membership and persists it in the cookie. Safe to
// call from Server Actions (sign-in, sign-up, invitation accept) where
// cookie writes are allowed. No-op when a cookie is already set.
export async function ensureCurrentOrgCookie(
  accessToken: string,
): Promise<string | null> {
  const existing = await readCurrentOrgId();
  if (existing) return existing;

  const res = await fetch(`${BACKEND_URL}/orgs`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as OrganizationMembershipResponse;
  const first = body.organizations?.[0]?.org?.id ?? null;
  if (first) await writeCurrentOrgId(first);
  return first;
}

export async function callAuthed<T>(path: string, opts: CallOpts = {}): Promise<T> {
  const session = await readSession();
  if (!session) throw new ApiError(401, "Not signed in");

  const orgId = opts.skipOrgHeader ? null : await readActiveOrgId();

  let res = await rawFetch(path, session.accessToken, orgId, opts);
  if (res.status === 401 && opts.refreshOn401 !== false) {
    const refreshed = await refreshSession(session.refreshToken);
    if (!refreshed) {
      await clearSession();
      throw new ApiError(401, "Session expired");
    }
    await writeSession(refreshed);
    res = await rawFetch(path, refreshed.accessToken, orgId, opts);
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
  const res = await rawFetch(path, null, null, { ...opts, refreshOn401: false });
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
