import { expect, it } from 'vitest';
import config from '../../vitest.config.js';

// Holds the declared fixture budget, not a claim about host capacity or latency.
// Real PostgreSQL isolation and concurrency cases inside each file are unchanged.
it('bounds fresh database fixture workers without extending test or hook deadlines', () => {
  expect(config.test?.fileParallelism).toBe(true);
  expect(config.test?.maxWorkers).toBe(4);
  expect(config.test?.testTimeout).toBe(30_000);
  expect(config.test?.hookTimeout).toBe(60_000);
});
