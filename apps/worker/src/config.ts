export const MAX_WORKER_CONCURRENCY = 128;

/** Parse bounded worker concurrency before constructing database or Graphile worker pools. */
export function workerConcurrency(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(environment['WORKER_CONCURRENCY'] ?? '4');
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WORKER_CONCURRENCY) {
    throw new Error(
      `WORKER_CONCURRENCY must be an integer from 1 through ${String(MAX_WORKER_CONCURRENCY)}`,
    );
  }
  return value;
}
