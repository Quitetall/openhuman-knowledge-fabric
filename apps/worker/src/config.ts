import { loadSecret } from '@kf/operations';
import { DEFAULT_EMBEDDING_CONCURRENCY, MAX_EMBEDDING_CONCURRENCY } from './embedding.js';

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

/**
 * Engine requests the embedding pump keeps in flight (SAS §100.44): KF_EMBEDDING_CONCURRENCY,
 * from 1 through MAX_EMBEDDING_CONCURRENCY, DEFAULT_EMBEDDING_CONCURRENCY when unset. Refused, not
 * clamped, when out of range: a value nobody can explain should stop the worker, not be guessed at.
 */
export function embeddingConcurrency(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment['KF_EMBEDDING_CONCURRENCY'];
  const value = raw === undefined || raw === '' ? DEFAULT_EMBEDDING_CONCURRENCY : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EMBEDDING_CONCURRENCY) {
    throw new Error(
      `KF_EMBEDDING_CONCURRENCY must be an integer from 1 through ${String(MAX_EMBEDDING_CONCURRENCY)}`,
    );
  }
  return value;
}
