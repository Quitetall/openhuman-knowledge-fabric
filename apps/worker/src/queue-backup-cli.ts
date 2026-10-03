import { createPool } from '@kf/database';
import { workerDatabaseUrl } from './config.js';
import { prepareWorkerQueue } from './queue-backup.js';

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('worker_queue_backup_refused');
  const connectionString = workerDatabaseUrl();
  if (connectionString === undefined) throw new Error('worker_queue_backup_refused');
  const pool = createPool({ connectionString, maxConnections: 2 });
  try {
    await prepareWorkerQueue(pool);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('worker_queue_backup_refused');
  process.exitCode = 1;
});
