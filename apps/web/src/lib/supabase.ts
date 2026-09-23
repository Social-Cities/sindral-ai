import { createClient } from '@supabase/supabase-js';

export const DEFAULT_SUPABASE_URL = 'http://127.0.0.1:55321';

const url = import.meta.env.VITE_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon-key-not-configured';

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  console.warn('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set; authentication will not work.');
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Current access token, or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
