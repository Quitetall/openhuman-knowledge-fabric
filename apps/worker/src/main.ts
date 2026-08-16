/**
 * Worker process entrypoint.
 *
 * With no DATABASE_URL the process stays alive and idle rather than crash-looping, so that
 * `pnpm dev` is usable before the Gate 3 kernel exists. It never pretends to be running
 * jobs: the idle state is logged explicitly.
 */

import { S3ObjectStore } from '@kf/artifacts';
import { createPool, type Pool } from '@kf/database';
import { PinnedLiminalProcessAdapter, preflightLiminalProcessHost } from '@kf/documents';
import { loadSecret, redact } from '@kf/operations';
import {
  compilationOutboxHandler,
  createCompilationRuntime,
  createPostgresCompilerRuntimeRepository,
  type CompilationRuntime,
} from './compiler-runtime.js';
import { workerConcurrency } from './config.js';
import { drainOutbox, OUTBOX_HANDLERS } from './outbox.js';
import { taskList, TASKS } from './tasks.js';

const OUTBOX_INTERVAL_MS = 1_000;

function configured(name: string): boolean {
  return process.env[name] !== undefined || process.env[`${name}_FILE`] !== undefined;
}

function databaseUrl(): string | undefined {
  const name = configured('WORKER_DATABASE_URL') ? 'WORKER_DATABASE_URL' : 'DATABASE_URL';
  return configured(name)
    ? loadSecret(name, process.env, { allowInline: process.env['NODE_ENV'] !== 'production' })
    : undefined;
}

function liminalRuntimeFilePaths(): readonly string[] {
  const configuredPaths = process.env['LIMINAL_RUNTIME_FILE_PATHS'];
  if (configuredPaths === undefined) return [];
  return configuredPaths
    .split(':')
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

async function compilationRuntime(pool: Pool): Promise<CompilationRuntime | undefined> {
  const liminal = [
    'LIMINAL_COMPILER_PATH',
    'LIMINAL_CARGO_LOCK_PATH',
    'LIMINAL_BWRAP_PATH',
    'LIMINAL_RUNTIME_FILE_PATHS',
    'LIMINAL_EXECUTABLE_SHA256',
    'LIMINAL_CARGO_LOCK_SHA256',
    'LIMINAL_RUNTIME_CLOSURE_SHA256',
  ] as const;
  const configuredLiminal = liminal.filter((name) => process.env[name] !== undefined);
  if (configuredLiminal.length === 0) return undefined;
  const required = [
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_BUCKET_ARTIFACTS',
    ...liminal,
  ] as const;
  const configuredValues = required.filter((name) => process.env[name] !== undefined);
  const secretConfigured = configured('S3_SECRET_ACCESS_KEY');
  if (configuredValues.length !== required.length || !secretConfigured) {
    throw new Error(
      `${required.join(', ')}, and S3_SECRET_ACCESS_KEY[_FILE] must all be set for document compilation`,
    );
  }

  const store = new S3ObjectStore({
    endpoint: process.env['S3_ENDPOINT']!,
    region: process.env['S3_REGION']!,
    accessKeyId: process.env['S3_ACCESS_KEY_ID']!,
    secretAccessKey: loadSecret('S3_SECRET_ACCESS_KEY', process.env, {
      allowInline: process.env['NODE_ENV'] !== 'production',
    }),
    bucket: process.env['S3_BUCKET_ARTIFACTS']!,
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] !== 'false',
  });
  const runtimeFilePaths = liminalRuntimeFilePaths();
  await preflightLiminalProcessHost({
    executablePath: process.env['LIMINAL_COMPILER_PATH']!,
    cargoLockPath: process.env['LIMINAL_CARGO_LOCK_PATH']!,
    executableDigest: process.env['LIMINAL_EXECUTABLE_SHA256']!,
    cargoLockDigest: process.env['LIMINAL_CARGO_LOCK_SHA256']!,
    runtimeClosureDigest: process.env['LIMINAL_RUNTIME_CLOSURE_SHA256']!,
    bubblewrapPath: process.env['LIMINAL_BWRAP_PATH']!,
    runtimeFilePaths,
  });
  return createCompilationRuntime({
    repository: createPostgresCompilerRuntimeRepository(pool),
    store,
    adapterFor: (identity) =>
      new PinnedLiminalProcessAdapter({
        identity,
        executablePath: process.env['LIMINAL_COMPILER_PATH']!,
        cargoLockPath: process.env['LIMINAL_CARGO_LOCK_PATH']!,
        bubblewrapPath: process.env['LIMINAL_BWRAP_PATH']!,
        runtimeFilePaths,
      }),
  });
}

function startOutboxPump(pool: Pool): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | undefined;
  const handlers = {
    ...OUTBOX_HANDLERS,
    'kf.request_document_compilation': compilationOutboxHandler,
  };
  const tick = (): void => {
    if (stopped || active !== undefined) return;
    active = drainOutbox(pool, { handlers })
      .then((result) => {
        if (result.failed > 0 || result.unhandled.length > 0) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'outbox drain incomplete',
              failed: result.failed,
              failures: result.failures.map((failure) => ({
                ...failure,
                error: redact(failure.error),
              })),
              unhandled: result.unhandled,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'outbox drain failed',
            error: redact(error instanceof Error ? error.message : String(error)),
          }),
        );
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, OUTBOX_INTERVAL_MS);
  timer.unref();
  tick();
  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}

async function main(): Promise<void> {
  // Absent stays absent — the idle path below is deliberate. What this adds is that a
  // DATABASE_URL_FILE is preferred where one is set, and that an inline credential in
  // production is refused rather than used.
  const connectionString = databaseUrl();

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

  const concurrency = workerConcurrency();
  const pool = createPool({
    connectionString,
    maxConnections: Math.max(2, concurrency + 2),
  });
  const runtime = await compilationRuntime(pool);
  if (runtime === undefined) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'Liminal or object-store configuration absent — compiler jobs remain retryable',
      }),
    );
  }
  const tasks = taskList(
    runtime === undefined
      ? undefined
      : { compileDocument: (actionId) => runtime.process(actionId) },
  );
  const { run } = await import('graphile-worker');
  const runner = await run({
    pgPool: pool,
    concurrency,
    noHandleSignals: true,
    taskList: tasks,
  });
  // Graphile migrations finish before this starts, so add_job exists before first drain.
  const outbox = startOutboxPump(pool);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await outbox.stop();
      await runner.stop('process signal');
    })();
    return stopping;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // Stop lets in-flight jobs finish; killing mid-job would leave an outbox row claimed
    // but undelivered until its lock expires.
    process.once(signal, () => void stop());
  }

  try {
    await runner.promise;
  } finally {
    await outbox.stop();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('fatal: worker failed to start');
  console.error(err);
  process.exit(1);
});
