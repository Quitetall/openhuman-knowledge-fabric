import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Gate 3 onward these talk to a real PostgreSQL via Testcontainers. A shared
    // database across parallel files would make invariant tests race each other.
    fileParallelism: true,
    // Each worker can initialize several real database instances. CPU-minus-one
    // workers oversubscribed fixture startup on the 32-thread shared host and
    // breached existing deadlines; keep isolation and those deadlines intact.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
