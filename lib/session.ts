import "server-only";
import { cookies } from "next/headers";

const ACCESS_COOKIE = "agatha_at";
const REFRESH_COOKIE = "agatha_rt";

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
}
