/**
 * Readiness, from a terminal or a cron entry.
 *
 *   kf-readiness              exit 0 only if everything is ok
 *   kf-readiness --json       the same, as JSON
 *
 * Exits non-zero on degraded as well as failed. A scheduled check that exits 0 while
 * something is wrong is worse than no scheduled check, because it is believed.
 */

import { createPool } from '@kf/database';
import { assessReadiness, formatReadiness } from './index.js';

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set');
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
    return report.ready ? 0 : 1;
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
