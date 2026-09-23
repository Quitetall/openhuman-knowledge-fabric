import { describe, expect, it, vi } from 'vitest';
import type * as Operations from '@kf/operations';

// The deep report walks the whole audit chain. Counting assessments is the only honest way to
// prove requests share one, so the assessor is replaced for this file alone.
const assess = vi.hoisted(() =>
  vi.fn(async () => ({
    ready: true,
    checks: [],
    service: { ready: true, checks: [] },
    institutional: { ready: true, checks: [] },
  })),
);
vi.mock('@kf/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof Operations>()),
  assessReadiness: assess,
}));

const { buildApp } = await import('./app.js');
const { loadConfig } = await import('./config.js');

describe('deep readiness cost', () => {
  it('runs one assessment for a burst of requests, not one per request', async () => {
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        KF_DEPLOYMENT_PROFILE: 'development',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgres://kf_app@127.0.0.1:1/kf',
      }),
    );
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/readiness' })),
    );
    expect(responses.every((res) => res.statusCode === 200)).toBe(true);
    expect(assess).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
