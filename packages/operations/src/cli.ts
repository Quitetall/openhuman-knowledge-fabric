/**
 * Readiness, from a terminal or a cron entry.
 *
 *   kf-readiness              show service and institutional reports
 *   kf-readiness --json       the same, as JSON
 *
 * Exit status follows service readiness. Institutional failures remain explicit and block
 * their governed operations, but do not make a working shared-dogfood service unavailable.
 */

import { createPool } from '@kf/database';
import { assessReadiness, formatReadiness } from './index.js';
import { loadSecret, SecretRejected } from './secrets.js';

async function main(): Promise<number> {
  let url: string;
  try {
    // DATABASE_URL_FILE where it is set, and a plain DATABASE_URL only outside production —
    // a connection string is a credential, and an environment variable is readable from
    // /proc by anything running as the same user.
    url = loadSecret('DATABASE_URL', process.env, {
      allowInline: process.env['NODE_ENV'] !== 'production',
    });
  } catch (err: unknown) {
    console.error(err instanceof SecretRejected ? err.message : String(err));
    return 2;
  }

  const pool = createPool({ connectionString: url, maxConnections: 2 });
  try {
    const report = await assessReadiness(pool);
    if (process.argv.includes('--json')) {
      console.warn(JSON.stringify(report, null, 2));
    } else {
      console.warn(formatReadiness(report));
    }
    return report.service.ready ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // A readiness check that cannot run is NOT ready. Reported as such rather than as a
    // crash, so a scheduler treats it the same way it treats a real failure.
    console.error(
      `readiness could not be assessed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  },
);
