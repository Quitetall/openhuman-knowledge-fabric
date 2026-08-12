/**
 * Worker process entrypoint.
 *
 * With no DATABASE_URL the process stays alive and idle rather than crash-looping, so that
 * `pnpm dev` is usable before the Gate 3 kernel exists. It never pretends to be running
 * jobs: the idle state is logged explicitly.
 */

import { loadSecret } from '@kf/operations';
import { taskList, TASKS } from './tasks.js';

const CONCURRENCY = Number(process.env['WORKER_CONCURRENCY'] ?? '4');

async function main(): Promise<void> {
  // Absent stays absent — the idle path below is deliberate. What this adds is that a
  // DATABASE_URL_FILE is preferred where one is set, and that an inline credential in
  // production is refused rather than used.
  const connectionString =
    process.env['DATABASE_URL_FILE'] !== undefined || process.env['DATABASE_URL'] !== undefined
      ? loadSecret('DATABASE_URL', process.env, {
          allowInline: process.env['NODE_ENV'] !== 'production',
        })
      : undefined;
  const tasks = taskList();

  if (!connectionString) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'DATABASE_URL not set — worker is idle and processing no jobs',
        registered_tasks: TASKS.map((t) => t.name),
      }),
    );
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => resolve());
      }
    });
    return;
  }

  const { run } = await import('graphile-worker');
  const runner = await run({ connectionString, concurrency: CONCURRENCY, taskList: tasks });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // Stop lets in-flight jobs finish; killing mid-job would leave an outbox row claimed
    // but undelivered until its lock expires.
    process.once(signal, () => void runner.stop());
  }

  await runner.promise;
}

main().catch((err: unknown) => {
  console.error('fatal: worker failed to start');
  console.error(err);
  process.exit(1);
});
