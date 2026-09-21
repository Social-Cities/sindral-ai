import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { SupabaseRepository, createSupabaseClient } from './db/supabase.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const repo = new SupabaseRepository(createSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey));
  const app = await buildApp({ config, repo });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
