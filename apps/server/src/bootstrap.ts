import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { SupabaseRepository, createSupabaseClient } from './db/supabase.js';

/** Initialize routes and validate the database without binding a listening socket. */
export async function initializeApp(config: AppConfig = loadConfig()) {
  const repo = new SupabaseRepository(createSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey));
  await repo.assertCompatibleSchema();
  const app = await buildApp({ config, repo });
  try {
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
