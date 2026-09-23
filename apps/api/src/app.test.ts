import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app.js';
import { ConfigError, loadConfig } from './config.js';

const baseEnv = {
  NODE_ENV: 'test',
  KF_DEPLOYMENT_PROFILE: 'development',
} as NodeJS.ProcessEnv;

describe('config', () => {
  it('defaults port and host in development', () => {
    const c = loadConfig({ NODE_ENV: 'development', KF_DEPLOYMENT_PROFILE: 'development' });
    expect(c.port).toBe(4000);
    // Loopback: the development profile trusts identity headers, so nothing else may dial it.
    expect(c.host).toBe('127.0.0.1');
    expect(c.deploymentProfile).toBe('development');
  });

  it.each([undefined, ''])('refuses to guess an unset NODE_ENV (%j)', (nodeEnv) => {
    // An unset NODE_ENV used to become `development`, the header-trusting posture. A unit file
    // that forgot the variable therefore booted the most permissive mode there is.
    const env: NodeJS.ProcessEnv = { KF_DEPLOYMENT_PROFILE: 'development' };
    if (nodeEnv !== undefined) env['NODE_ENV'] = nodeEnv;
    expect(() => loadConfig(env)).toThrow(/NODE_ENV is required/);
  });

  it.each(['0.0.0.0', '::', '192.0.2.10'])(
    'refuses a non-loopback listener under the header-trusting development profile (%s)',
    (host) => {
      expect(() =>
        loadConfig({ NODE_ENV: 'development', KF_DEPLOYMENT_PROFILE: 'development', HOST: host }),
      ).toThrow(/development profile .* only on loopback/);
    },
  );

  it('requires an explicit deployment profile', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(
      /KF_DEPLOYMENT_PROFILE is required/,
    );
  });

  it('rejects an unknown deployment profile rather than guessing', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', KF_DEPLOYMENT_PROFILE: 'shared' })).toThrow(
      /KF_DEPLOYMENT_PROFILE must be development or dogfood/,
    );
  });

  it('keeps the visibly non-authoritative development profile out of deployed environments', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        KF_DEPLOYMENT_PROFILE: 'development',
        KF_TLS_TERMINATED_UPSTREAM: '1',
      }),
    ).toThrow(/development profile is allowed only when NODE_ENV=development or test/);
  });

  it('requires a real identity provider for dogfood even under NODE_ENV=development', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', KF_DEPLOYMENT_PROFILE: 'dogfood' })).toThrow(
      /identity provider is required when KF_DEPLOYMENT_PROFILE=dogfood/,
    );
  });

  it('accepts a complete OIDC configuration for dogfood', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
      OIDC_AUDIENCE: 'knowledge-fabric-api',
      OIDC_JWKS_URI: 'http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs',
    });

    expect(config.deploymentProfile).toBe('dogfood');
    expect(config.identity).toEqual({
      issuer: 'http://localhost:8080/realms/knowledge-fabric',
      audience: 'knowledge-fabric-api',
      jwksUri: 'http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs',
    });
    expect(config.host).toBe('127.0.0.1');
  });

  it('refuses cleartext dogfood on a non-loopback listener', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        HOST: '0.0.0.0',
        OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
        OIDC_AUDIENCE: 'knowledge-fabric-api',
        OIDC_JWKS_URI:
          'http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs',
      }),
    ).toThrow(/cleartext dogfood.*loopback/);
  });

  it.each(['0', '65536', 'abc', '4000.5'])('rejects invalid PORT %s', (port) => {
    expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow(ConfigError);
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig({ NODE_ENV: 'prod', KF_DEPLOYMENT_PROFILE: 'development' })).toThrow(
      ConfigError,
    );
  });

  it('refuses to boot in production without DATABASE_URL', () => {
    // A process that boots and passes liveness but fails every request is worse than one
    // that refuses to start.
    // The TLS posture is asserted so that THIS test fails for the reason it names. Without
    // it the config refuses earlier, and the test would pass while proving something else.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_TLS_TERMINATED_UPSTREAM: '1',
      }),
    ).toThrow(/DATABASE_URL is required/);
  });

  it('allows a missing DATABASE_URL in development and test', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', KF_DEPLOYMENT_PROFILE: 'development' }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: 'test', KF_DEPLOYMENT_PROFILE: 'development' }),
    ).not.toThrow();
  });

  it('refuses an inline DATABASE_URL in production', () => {
    // A connection string in the environment is readable from /proc/<pid>/environ by anything
    // running as the same user, inherited by every child process, and printed in full by most
    // crash reporters. Outside development it has to arrive as a file.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_TLS_TERMINATED_UPSTREAM: '1',
        DATABASE_URL: 'postgres://kf_app:secret@db/kf',
      }),
    ).toThrow(/DATABASE_URL_FILE/);
  });

  it('refuses to boot in production unless the deployment states its TLS posture', () => {
    // This process serves plain HTTP. Whether that is safe depends entirely on what is in
    // front of it, and that is a fact about the deployment which the deployment has to
    // assert — not one this code can assume in either direction.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        DATABASE_URL_FILE: '/dev/null',
      }),
    ).toThrow(/KF_TLS_TERMINATED_UPSTREAM/);
  });

  it('does not require the TLS assertion in development', () => {
    // Refusing here would make `pnpm dev` need a flag that means nothing locally, and a flag
    // people set to make the error go away is a flag that means nothing anywhere.
    expect(
      loadConfig({ NODE_ENV: 'development', KF_DEPLOYMENT_PROFILE: 'development' })
        .tlsTerminatedUpstream,
    ).toBe(false);
  });
});

describe('transport and content security headers', () => {
  it('sends the headers that matter over a plain-HTTP hop', async () => {
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    // nosniff: a JSON error body must never be executed as script if it is ever fetched
    // cross-origin. DENY: a UI that approves payments is what clickjacking is for. no-store:
    // responses carry records the browser cache has no business keeping.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('does not claim HSTS in development, where there is no TLS to pin', async () => {
    // Sending it from a local http:// origin teaches the browser to refuse the developer's
    // own machine, which is a genuinely unpleasant afternoon.
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });
});

describe('health endpoints', () => {
  it('reports liveness without touching dependencies', async () => {
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    // toEqual, not toMatchObject: this endpoint is unauthenticated, so the assertion has to
    // forbid EXTRA keys. Adding an environment name, version or build id here would be
    // free reconnaissance, and toMatchObject would let it through silently.
    expect(res.json()).toEqual({ service: SERVICE_NAME, status: 'ok' });
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

  it('reports NOT ready when the configured database is unreachable', async () => {
    // Readiness is a round trip, not a configuration check. This test previously asserted
    // that a configured URL alone meant ready — which would hand traffic to a process that
    // cannot reach its database, exactly the case the probe exists to catch.
    //
    // Readiness against a REACHABLE database is covered in tests/permissions, which has one.
    const app = await buildApp(
      loadConfig({
        ...baseEnv,
        LOG_LEVEL: 'silent',
        // Port 1 is privileged and never listening, so this fails fast and deterministically
        // rather than depending on whatever happens to be on 5432.
        DATABASE_URL: 'postgres://kf_app@127.0.0.1:1/kf',
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ready: false, checks: { database: 'failing' } });
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

describe('identity on every route, not only /actions', () => {
  it('refuses header identity on /search when the profile does not trust headers', async () => {
    // A hand-built dogfood config with no identity provider: exactly the case loadConfig
    // refuses but buildApp accepts. Only /actions used to honour trustHeaders; /search took
    // the same x-kf-* headers as the caller and went on to the database.
    const config = {
      ...loadConfig({
        ...baseEnv,
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgres://kf_app@127.0.0.1:1/kf',
      }),
      deploymentProfile: 'dogfood' as const,
    };
    const app = await buildApp(config);
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=pump',
      headers: {
        'x-kf-actor': '01930000-0000-7000-8000-000000000001',
        'x-kf-acting-role': '01930000-0000-7000-8000-000000000002',
        'x-kf-organization': '01930000-0000-7000-8000-000000000003',
        'x-kf-classification': 'restricted',
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('error bodies', () => {
  it('answers an unhandled failure with a request id, never the error text', async () => {
    // Fastify's default handler returned err.message on a 500. From pg that names the host,
    // port and role; from a constraint it can quote the row.
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    app.get('/boom', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 as kf_owner');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', requestId: res.headers['x-request-id'] });
    await app.close();
  });

  it('keeps Fastify refusals about the request itself as 4xx', async () => {
    const app = await buildApp(loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' }));
    app.post('/echo', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ requestId: res.headers['x-request-id'] });
    await app.close();
  });
});
