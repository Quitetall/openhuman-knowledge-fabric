/**
 * kf-attestor: the API's identity path now ends in the database's attestation (20260924001000).
 *
 * The attestor here is the real one — `createAttestorServer` over a real Unix socket, running
 * `resolveCaller` under the attestor's own database login — and the API side is the real
 * `SocketAttestor` and route code, connected as a bare `kf_app` login with NO attestation issuer
 * registered: exactly what the dogfood API holds. So a route that works here works only because
 * the attestation crossed the socket and reached `core.bind_principal`.
 *
 * Every bad token is refused with the one collapsed code AND leaves no attestation behind: an
 * attestor that refused the caller but had already vouched for them would be the hole this closes.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  IdentityRejected,
  LocalAttestor,
  SocketAttestor,
  TokenVerifier,
  linkIdentity,
} from '@kf/authorization';
import {
  PrincipalRefused,
  bindPrincipal,
  createPool,
  withTransaction,
  type Pool,
} from '@kf/database';
import { InMemoryObjectStore } from '@kf/artifacts';
import { PandocDocumentParser, createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { createAttestorServer } from '../../apps/attestor/src/server.js';
import { createCallerIdentifier, registerActionRoutes } from '../../apps/api/src/routes/actions.js';
import { registerSearchRoutes } from '../../apps/api/src/routes/search.js';
import { registerVerificationRoutes } from '../../apps/api/src/routes/verifications.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

const ISSUER = 'https://id.openhuman.invalid/realms/openhuman';
const AUDIENCE = 'knowledge-fabric';

let h: Harness;
let f: Fixtures;
let privateKey: KeyObject;
let bareApp: Pool;
let server: Server;
let socketDir: string;
let socketPath: string;
let attestor: SocketAttestor;

async function token(
  claims: {
    subject?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    omitExpiration?: boolean;
    alg?: 'RS256' | 'RS512';
  } = {},
): Promise<string> {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: claims.alg ?? 'RS256', kid: 'test-key' })
    .setSubject(claims.subject ?? 'auth0|reviewer')
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? AUDIENCE)
    .setIssuedAt();
  return (claims.omitExpiration ? jwt : jwt.setExpirationTime(claims.expiresIn ?? '5m')).sign(
    privateKey,
  );
}

const asked = (bearer: string, over: { actingRoleId?: string; organizationId?: string } = {}) => ({
  token: bearer,
  actingRoleId: over.actingRoleId ?? f.reviewerRoleId,
  organizationId: over.organizationId ?? f.organizationId,
  maxClassification: 'restricted',
});

const attestationCount = async (): Promise<number> =>
  Number(
    (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ n: string }>('select count(*)::text as n from core.principal_attestation'),
      )
    ).n,
  );

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  // A plain RSA key object rather than a WebCrypto key pinned to one hash, so the SAME key can
  // sign an RS512 token and the algorithm is the only thing wrong with it.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key' };
  // No `alg` on the key, so the key set would serve an RS512 token too: the pinned algorithm
  // list in TokenVerifier is the only thing refusing it.
  const verifier = new TokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
    createLocalJWKSet({ keys: [publicJwk] }),
  );

  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await linkIdentity(tx, {
      issuer: ISSUER,
      subject: 'auth0|reviewer',
      personId: f.reviewerId,
      providerLabel: 'Reviewer',
      linkedBy: f.performerId,
    });
  });

  // The dogfood API's login: kf_app and nothing else, and no issuer registered on its pool.
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role kf_attestor_test_api login password 'test-only-not-a-secret'`);
    await tx.query('grant kf_app to kf_attestor_test_api');
    await tx.query('grant connect on database kf_test to kf_attestor_test_api');
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_attestor_test_api';
  uri.password = 'test-only-not-a-secret';
  bareApp = createPool({ connectionString: uri.toString(), maxConnections: 3 });

  socketDir = mkdtempSync(join(tmpdir(), 'kf-attestor-'));
  socketPath = join(socketDir, 'attestor.sock');
  server = createAttestorServer(new LocalAttestor(h.attestorPool, verifier));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  attestor = new SocketAttestor(socketPath);
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
  await bareApp?.end();
  await h?.stop();
});

describe('a valid token, across the socket', () => {
  it('comes back as the person, with an attestation the application login binds on', async () => {
    const caller = await attestor.identify(asked(await token()));
    expect(caller.actorId).toBe(f.reviewerId);
    expect(caller.attestation).toMatch(/^[0-9a-f]{64}$/);
    const ceiling = await withTransaction(bareApp, (tx) => bindPrincipal(tx, caller));
    expect(ceiling).toBe('restricted');
  });

  it('without the attestation, the same caller binds nobody', async () => {
    const caller = await attestor.identify(asked(await token()));
    const err = await withTransaction(bareApp, (tx) =>
      bindPrincipal(tx, { ...caller, attestation: undefined }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrincipalRefused);
    expect((err as PrincipalRefused).reason).toBe('not_attested');
  });

  it('answers health for readiness', async () => {
    expect(await attestor.healthy()).toBe(true);
    expect(await new SocketAttestor(join(socketDir, 'absent.sock')).healthy()).toBe(false);
  });
});

describe('a bad token is refused, and nothing is attested', () => {
  const cases: Array<[string, () => Promise<string>]> = [
    ['from another issuer', () => token({ issuer: 'https://evil.invalid/' })],
    ['for another audience', () => token({ audience: 'some-other-service' })],
    ['signed with an algorithm other than RS256', () => token({ alg: 'RS512' })],
    ['expired', () => token({ expiresIn: '-1h' })],
    ['with no expiry', () => token({ omitExpiration: true })],
    [
      'signed by another key',
      async () => {
        const other = await generateKeyPair('RS256', { extractable: true });
        return new SignJWT({})
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setSubject('auth0|reviewer')
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(other.privateKey);
      },
    ],
  ];

  it.each(cases)('refuses a token %s', async (_name, make) => {
    const before = await attestationCount();
    const err = await attestor.identify(asked(await make())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('invalid_token');
    expect(await attestationCount()).toBe(before);
  });

  it('refuses a subject nobody linked, and a role the person does not hold', async () => {
    const before = await attestationCount();
    const stranger = await attestor
      .identify(asked(await token({ subject: 'auth0|stranger' })))
      .catch((e: unknown) => e);
    expect((stranger as IdentityRejected).failure).toBe('unknown_subject');
    const borrowed = await attestor
      .identify(asked(await token(), { actingRoleId: f.performerRoleId }))
      .catch((e: unknown) => e);
    expect((borrowed as IdentityRejected).failure).toBe('role_not_held');
    expect(await attestationCount()).toBe(before);
  });

  it('refuses a malformed request without reading a token', async () => {
    const answer = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { socketPath, path: '/attest', method: 'POST', headers: { 'content-type': 'text/plain' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{"token": 7}');
    });
    expect(answer).toBe(400);
  });
});

describe('the API routes, bound only through the attestation', () => {
  let api: FastifyInstance;

  beforeAll(async () => {
    api = Fastify({ logger: false });
    const identify = createCallerIdentifier(bareApp, attestor, { trustHeaders: false });
    await registerSearchRoutes(api, { pool: bareApp, identify });
    // Document atoms carry verify_record; the store is never touched by the acts used here.
    const execute = createFabricDispatcher(
      bareApp,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: new PandocDocumentParser(),
      }),
    );
    await registerActionRoutes(api, {
      pool: bareApp,
      attestor,
      trustHeaders: false,
      execute,
    });
    registerVerificationRoutes(api, { execute, identify });
    await api.ready();
  });

  afterAll(async () => {
    await api?.close();
  });

  const headers = async (bearer?: string) => ({
    authorization: `Bearer ${bearer ?? (await token())}`,
    'x-kf-acting-role': f.reviewerRoleId,
    'x-kf-organization': f.organizationId,
    'x-kf-classification': 'restricted',
  });

  it('serves a read', async () => {
    const r = await api.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: await headers(),
    });
    expect(r.statusCode).toBe(200);
  });

  it('dispatches an action, the attestation carried into the dispatcher', async () => {
    const r = await api.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: await headers(),
      payload: {
        idempotencyKey: 'attestor-create-initiative-0001',
        payload: {
          title: 'Attested initiative',
          objective: 'Created over HTTP by a caller the attestor vouched for.',
          sponsor_id: f.reviewerId,
        },
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it('verifies in bulk, the attestation carried into every act of the gesture', async () => {
    // The bulk route builds one dispatch per record. It was merged without carrying the caller's
    // attestation, which every development and test pool papered over with its issuer; here,
    // as on a dogfood host, each act was refused as not_attested.
    const ids = [
      await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'draft',
        title: 'Attested bulk record',
        createdBy: f.performerId,
      }),
    ];
    const r = await api.inject({
      method: 'POST',
      url: '/verifications/bulk',
      headers: await headers(),
      payload: {
        recordIds: ids,
        reason: 'promoting the imported register after sampling ten',
        idempotencyKey: 'attestor-bulk-0001',
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect((r.json() as { refused: unknown[] }).refused).toEqual([]);
  });

  it('refuses a forged token at the door', async () => {
    const r = await api.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: await headers(await token({ issuer: 'https://evil.invalid/' })),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: 'invalid_token' });
  });
});
