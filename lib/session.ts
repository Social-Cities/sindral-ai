import "server-only";
import { cookies } from "next/headers";

const ACCESS_COOKIE = "sindral_at";
const REFRESH_COOKIE = "sindral_rt";
const ORG_COOKIE = "sindral_org";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const at = store.get(ACCESS_COOKIE)?.value;
  const rt = store.get(REFRESH_COOKIE)?.value;
  if (!at || !rt) return null;
  return { accessToken: at, refreshToken: rt };
}

export async function writeSession(session: Session): Promise<void> {
  const store = await cookies();
  store.set(ACCESS_COOKIE, session.accessToken, {
    ...COOKIE_OPTS,
    // Supabase access tokens default to 1h. Refresh swaps both cookies.
    maxAge: 60 * 60,
  });
  store.set(REFRESH_COOKIE, session.refreshToken, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(ORG_COOKIE);
}

// Currently-active organization. The backend reads this via the x-org-id
// header on every authenticated call; switching orgs is a one-line cookie
// write + revalidate.
export async function readCurrentOrgId(): Promise<string | null> {
  const store = await cookies();
  return store.get(ORG_COOKIE)?.value ?? null;
}

export async function writeCurrentOrgId(orgId: string): Promise<void> {
  const store = await cookies();
  store.set(ORG_COOKIE, orgId, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearCurrentOrgId(): Promise<void> {
  const store = await cookies();
  store.delete(ORG_COOKIE);
}
