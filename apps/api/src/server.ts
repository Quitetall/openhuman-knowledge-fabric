/**
 * API process entrypoint.
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  // Terminate cleanly so in-flight action transactions either commit or roll back, rather
  // than being severed mid-transaction by a hard exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, 'error during shutdown');
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error('fatal: api failed to start');
  console.error(err);
  process.exit(1);
});
