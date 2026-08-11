import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app.js';
import { ConfigError, loadConfig } from './config.js';

const baseEnv = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

describe('config', () => {
  it('defaults port and host in development', () => {
    const c = loadConfig({ NODE_ENV: 'development' });
    expect(c.port).toBe(4000);
    expect(c.host).toBe('0.0.0.0');
  });

  it.each(['0', '65536', 'abc', '4000.5'])('rejects invalid PORT %s', (port) => {
    expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow(ConfigError);
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig({ NODE_ENV: 'prod' })).toThrow(ConfigError);
  });

  it('refuses to boot in production without DATABASE_URL', () => {
    // A process that boots and passes liveness but fails every request is worse than one
    // that refuses to start.
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is required/);
  });

  it('allows a missing DATABASE_URL in development and test', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });
});

describe('health endpoints', () => {
  it('reports liveness without touching dependencies', async () => {
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: SERVICE_NAME, status: 'ok' });
    await app.close();
  });

  it('reports NOT ready while the database is unconfigured', async () => {
    // Claiming readiness before the kernel exists would make the probe meaningless.
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ready: false, checks: { database: 'unconfigured' } });
    await app.close();
  });

  it('reports ready once a database is configured', async () => {
    const app = await buildApp(
      loadConfig({
        ...baseEnv,
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgres://kf_app@localhost:5432/kf',
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true });
    await app.close();
  });

  it('returns a correlation id the caller can quote', async () => {
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(first.headers['x-request-id']).toMatch(uuid);
    // Distinct per request, or it cannot correlate anything.
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    await app.close();
  });
});
