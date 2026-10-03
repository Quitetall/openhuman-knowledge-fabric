import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_WORKER_CONCURRENCY, workerConcurrency, workerDatabaseUrl } from './config.js';

describe('worker database credential policy', () => {
  it('does not invent credentials and prefers an explicitly configured worker credential', () => {
    expect(workerDatabaseUrl({})).toBeUndefined();
    expect(workerDatabaseUrl({ DATABASE_URL: 'test-only-fallback' })).toBe('test-only-fallback');
    expect(
      workerDatabaseUrl({
        DATABASE_URL: 'test-only-fallback',
        WORKER_DATABASE_URL: 'test-only-worker',
      }),
    ).toBe('test-only-worker');
    expect(() =>
      workerDatabaseUrl({ DATABASE_URL: 'test-only-fallback', WORKER_DATABASE_URL: '' }),
    ).toThrow(/WORKER_DATABASE_URL_FILE/);
  });

  it('refuses inline credentials in production for either variable', () => {
    for (const name of ['WORKER_DATABASE_URL', 'DATABASE_URL']) {
      expect(() => workerDatabaseUrl({ NODE_ENV: 'production', [name]: 'test-only' })).toThrow(
        /supplied inline/,
      );
    }
  });

  it('shares the owned-file permission check and never falls back after a worker-file refusal', () => {
    const root = mkdtempSync(join(tmpdir(), 'kf-worker-config-'));
    try {
      const admitted = join(root, 'admitted');
      const rejected = join(root, 'rejected');
      writeFileSync(admitted, 'test-only-worker\n', { mode: 0o600 });
      writeFileSync(rejected, 'test-only-rejected', { mode: 0o644 });
      expect(
        workerDatabaseUrl({ NODE_ENV: 'production', WORKER_DATABASE_URL_FILE: admitted }),
      ).toBe('test-only-worker');
      expect(workerDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL_FILE: admitted })).toBe(
        'test-only-worker',
      );
      expect(() =>
        workerDatabaseUrl({
          WORKER_DATABASE_URL_FILE: rejected,
          DATABASE_URL: 'test-only-fallback',
        }),
      ).toThrow(/readable beyond its owner/);
      expect(() =>
        workerDatabaseUrl({
          WORKER_DATABASE_URL_FILE: join(root, 'absent'),
          DATABASE_URL_FILE: admitted,
        }),
      ).toThrow(/cannot be read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('worker concurrency', () => {
  it('defaults to four and accepts bounded endpoints', () => {
    expect(workerConcurrency({})).toBe(4);
    expect(workerConcurrency({ WORKER_CONCURRENCY: '1' })).toBe(1);
    expect(workerConcurrency({ WORKER_CONCURRENCY: String(MAX_WORKER_CONCURRENCY) })).toBe(128);
  });

  it.each(['0', '129', '100000000', '1.5', 'not-a-number'])(
    'rejects unsafe concurrency %s before worker allocation',
    (configured) => {
      expect(() => workerConcurrency({ WORKER_CONCURRENCY: configured })).toThrow(
        /integer from 1 through 128/,
      );
    },
  );
});
