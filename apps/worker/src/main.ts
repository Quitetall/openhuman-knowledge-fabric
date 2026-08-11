/**
 * Worker process entrypoint.
 *
 * With no DATABASE_URL the process stays alive and idle rather than crash-looping, so that
 * `pnpm dev` is usable before the Gate 3 kernel exists. It never pretends to be running
 * jobs: the idle state is logged explicitly.
 */

import { taskList, TASKS } from './tasks.js';

const CONCURRENCY = Number(process.env['WORKER_CONCURRENCY'] ?? '4');

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
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
