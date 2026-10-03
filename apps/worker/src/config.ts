import { loadSecret } from '@kf/operations';

export const MAX_WORKER_CONCURRENCY = 128;

/** Resolve the worker's ordinary owned-file credential, sharing startup and CLI policy. */
export function workerDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = (name: string): boolean =>
    environment[name] !== undefined || environment[`${name}_FILE`] !== undefined;
  const name = configured('WORKER_DATABASE_URL') ? 'WORKER_DATABASE_URL' : 'DATABASE_URL';
  return configured(name)
    ? loadSecret(name, environment, { allowInline: environment['NODE_ENV'] !== 'production' })
    : undefined;
}

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
