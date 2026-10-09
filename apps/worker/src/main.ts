/**
 * Worker process entrypoint.
 *
 * With no DATABASE_URL the process stays alive and idle rather than crash-looping, so that
 * `pnpm dev` is usable before the Gate 3 kernel exists. It never pretends to be running
 * jobs: the idle state is logged explicitly.
 */

import { createPool, type Pool } from '@kf/database';
import { redact } from '@kf/operations';
import {
  compilationOutboxHandler,
  createCompilationRuntime,
  type CompilationRuntime,
} from './compiler-runtime.js';
import { compilerEnvironment } from './compiler-environment.js';
import { embeddingConcurrency, workerConcurrency, workerDatabaseUrl } from './config.js';
import { prepareWorkerQueue } from './queue-backup.js';
import { RetrievalClient } from '@kf/retrieval';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  embeddingBacklog,
  embeddingOutboxHandler,
  requireVectorsOnlyEngine,
  startEmbeddingPump,
} from './embedding.js';
import { drainOutbox, OUTBOX_HANDLERS, type OutboxHandler } from './outbox.js';
import { sweepTransientObservations } from './transient.js';
import { taskList, TASKS } from './tasks.js';

const OUTBOX_INTERVAL_MS = 1_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * The retrieval engine (KF_RETRIEVAL_SOCKET), checked before the worker starts: an engine that
 * does not declare a vectors-only write path, or embeds off-host, is refused here rather than
 * handed record text later (KF-SAS-RQ-218, RQ-225).
 */
async function retrievalEngine(): Promise<RetrievalClient | undefined> {
  const socketPath = process.env['KF_RETRIEVAL_SOCKET'];
  if (socketPath === undefined || socketPath === '') return undefined;
  if (!socketPath.startsWith('/')) {
    throw new Error(
      `KF_RETRIEVAL_SOCKET must be an absolute path, got ${JSON.stringify(socketPath)}`,
    );
  }
  // A write embeds one record's whole text, which on a CPU embedder takes seconds; the client's
  // default (two seconds, sized for a query) would abandon it mid-embedding and retry it.
  const client = new RetrievalClient({ socketPath, timeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS });
  await requireVectorsOnlyEngine(client);
  return client;
}

/** A pump that runs `step` every `intervalMs`, never two at once, logging what it returns. */
function startPump(
  name: string,
  intervalMs: number,
  step: () => Promise<unknown>,
): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = (): void => {
    if (stopped || active !== undefined) return;
    active = step()
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: `${name} failed`,
            error: redact(error instanceof Error ? error.message : String(error)),
          }),
        );
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
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

async function compilationRuntime(pool: Pool): Promise<CompilationRuntime | undefined> {
  const environment = await compilerEnvironment(pool);
  return environment === undefined ? undefined : createCompilationRuntime(environment);
}

function startOutboxPump(
  pool: Pool,
  defaultHandler: OutboxHandler | undefined,
): { stop(): Promise<void> } {
  let stopped = false;
  let active: Promise<void> | undefined;
  const handlers = {
    ...OUTBOX_HANDLERS,
    ...(defaultHandler === undefined ? {} : { '*': defaultHandler }),
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
  const connectionString = workerDatabaseUrl();

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
  // Refused here, before anything starts, rather than when the pump first runs.
  const embeddingSlots = embeddingConcurrency();
  const pool = createPool({
    connectionString,
    // Graphile's jobs, each embedding consumer's short claim and completion, and the pumps.
    maxConnections: Math.max(2, concurrency + embeddingSlots + 2),
  });
  // Before anything else starts: an engine that fails the handshake ends the process here.
  const engine = await retrievalEngine();
  if (engine === undefined) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'KF_RETRIEVAL_SOCKET not set — records are indexed lexically and not embedded',
      }),
    );
  }
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
  await prepareWorkerQueue(pool);
  const runner = await run({
    pgPool: pool,
    concurrency,
    noHandleSignals: true,
    taskList: tasks,
  });
  // Graphile migrations finish before this starts, so add_job exists before first drain.
  const outbox = startOutboxPump(pool, engine === undefined ? undefined : embeddingOutboxHandler);
  const embedding =
    engine === undefined
      ? undefined
      : startEmbeddingPump(pool, engine, {
          concurrency: embeddingSlots,
          engineTimeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS,
          onPass: (result, waitMs) => {
            if (result.stoppedBy === 'empty' && result.failed.length === 0) return;
            void embeddingBacklog(pool)
              .catch(() => undefined)
              .then((backlog) => {
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    msg:
                      result.stoppedBy === 'engine_unavailable'
                        ? 'embedding engine unavailable; backing off'
                        : result.stoppedBy === 'failing'
                          ? 'embedding engine failing; backing off'
                          : 'embedding drain incomplete',
                    claimed: result.claimed,
                    embedded: result.embedded,
                    waitMs,
                    ...(result.reason === undefined ? {} : { reason: redact(result.reason) }),
                    failed: result.failed,
                    ...(backlog === undefined ? {} : { backlog }),
                  }),
                );
              });
          },
          onError: (error, waitMs) => {
            console.error(
              JSON.stringify({
                level: 'error',
                msg: 'embedding drain failed',
                waitMs,
                error: redact(error instanceof Error ? error.message : String(error)),
              }),
            );
          },
        });
  const sweep = startPump('transient observation sweep', SWEEP_INTERVAL_MS, () =>
    sweepTransientObservations(pool),
  );

  const stopPumps = async (): Promise<void> => {
    await outbox.stop();
    await embedding?.stop();
    await sweep.stop();
  };

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await stopPumps();
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
    await stopPumps();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('fatal: worker failed to start');
  console.error(err);
  process.exit(1);
});
