import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '@kf/database';
import * as database from '@kf/database';
import { TokenVerifier } from '@kf/authorization';
import { createCallerIdentifier } from './actions/auth.js';
import { registerContextSourceRoutes } from './context-source.js';
import { loadConfig } from '../config.js';
import { buildApp } from '../app.js';
import type { IdentifyCaller } from './actions/contracts.js';

vi.mock('./actions/auth.js', () => ({ createCallerIdentifier: vi.fn() }));

const identify = vi.fn<IdentifyCaller>();
const reference = {
  adapter: 'knowledge-fabric',
  record: 'a',
  revision: 'a'.repeat(64),
  digest: 'b'.repeat(64),
};

beforeEach(() => {
  vi.clearAllMocks();
  identify.mockRejectedValue(new Error('sensitive provider failure'));
  vi.mocked(createCallerIdentifier).mockReturnValue(identify);
});

async function fixture() {
  const app = Fastify();
  const pool = createPool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
  const verifier = new TokenVerifier({
    issuer: 'https://identity.invalid',
    audience: 'kf',
    jwksUri: 'https://identity.invalid/keys',
  });
  await registerContextSourceRoutes(app, { pool, verifier });
  return {
    app,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

describe('private context source transport', () => {
  it.each(['read', 'retrieve'])(
    'propagates a real socket disconnect into %s work',
    async (operation) => {
      identify.mockResolvedValue({
        actorId: 'person',
        actingRoleId: 'role',
        organizationId: 'org',
        maxClassification: 'internal',
        authentication: {
          authenticatedAt: undefined,
          assuranceLevel: undefined,
          methods: [],
        },
      });
      let entered!: () => void;
      let cancelled!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const stopped = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const transaction = vi.spyOn(database, 'withReadTransaction').mockImplementation(
        async (_pool, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                cancelled();
                reject(signal.reason);
              },
              { once: true },
            );
            entered();
          }),
      );
      const { app, close } = await fixture();
      const client = new AbortController();
      try {
        const base = await app.listen({ host: '127.0.0.1', port: 0 });
        const request = fetch(`${base}/context-source/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: client.signal,
          body: JSON.stringify(operation === 'read' ? reference : { query: 'facts', limit: 10 }),
        });
        const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
        await started;
        client.abort();
        await rejected;
        await stopped;
        expect(transaction).toHaveBeenCalledTimes(1);
      } finally {
        client.abort();
        await close();
        transaction.mockRestore();
      }
    },
  );

  it('requires explicit opt-in, verified identity, database and literal loopback', async () => {
    const env = {
      NODE_ENV: 'test',
      KF_DEPLOYMENT_PROFILE: 'development',
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      OIDC_ISSUER: 'https://identity.invalid',
      OIDC_AUDIENCE: 'kf',
      OIDC_JWKS_URI: 'https://identity.invalid/keys',
    };
    expect(loadConfig(env).contextSourceEnabled).toBe(false);
    const enabled = { ...env, KF_CONTEXT_SOURCE_ENABLED: '1' };
    expect(loadConfig(enabled).contextSourceEnabled).toBe(true);
    for (const host of ['0.0.0.0', 'localhost', '192.0.2.1']) {
      expect(() => loadConfig({ ...enabled, HOST: host })).toThrow(/literal loopback/);
    }
    expect(() => loadConfig({ ...enabled, DATABASE_URL: undefined })).toThrow(/requires/);
    expect(() =>
      loadConfig({
        ...enabled,
        OIDC_ISSUER: undefined,
        OIDC_AUDIENCE: undefined,
        OIDC_JWKS_URI: undefined,
      }),
    ).toThrow(/requires/);
    await expect(buildApp({ ...loadConfig(enabled), host: '0.0.0.0' })).rejects.toThrow(
      /literal loopback/,
    );
  });

  it.each(['read', 'retrieve'])(
    'refuses a nonlocal peer before identity lookup: %s',
    async (operation) => {
      const { app, close } = await fixture();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/context-source/${operation}`,
          remoteAddress: '192.0.2.1',
          payload: operation === 'read' ? reference : { query: 'facts', limit: 10 },
        });
        expect(response.statusCode).toBe(403);
        expect(identify).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );

  it.each(['read', 'retrieve'])(
    'does not trust actor headers or expose provider failure details: %s',
    async (operation) => {
      const { app, close } = await fixture();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/context-source/${operation}`,
          remoteAddress: '127.0.0.1',
          headers: { 'x-kf-actor': 'admin' },
          payload: operation === 'read' ? reference : { query: 'facts', limit: 10 },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'caller_unidentified' });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(identify).toHaveBeenCalledTimes(1);
      } finally {
        await close();
      }
    },
  );

  it('rejects malformed references before authentication', async () => {
    const { app, close } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/context-source/read',
        remoteAddress: '127.0.0.1',
        payload: { ...reference, digest: 'invalid' },
      });
      expect(response.statusCode).toBe(400);
      expect(identify).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it.each([0, 201, -1, 1.5])(
    'rejects invalid retrieval limit %s before authentication',
    async (limit) => {
      const { app, close } = await fixture();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/context-source/retrieve',
          remoteAddress: '127.0.0.1',
          payload: { query: 'facts', limit },
        });
        expect(response.statusCode).toBe(400);
        expect(identify).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );
});
