import { describe, expect, it } from 'vitest';
import { MAX_WORKER_CONCURRENCY, workerConcurrency } from './config.js';

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
