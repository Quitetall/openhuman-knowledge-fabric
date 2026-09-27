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
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  AttestorUnavailable,
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
import { createHoldingsLister } from '../../apps/api/src/routes/actions/auth.js';
import { registerSessionRoutes } from '../../apps/api/src/routes/session.js';
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
let verifierForFlaky: TokenVerifier;

async function token(
  claims: {
    subject?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    omitExpiration?: boolean;
    alg?: 'RS256' | 'RS512';
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const jwt = new SignJWT(claims.extra ?? {})
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
  verifierForFlaky = verifier;
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

  it('names the search surface, so a refusal of GET /search before binding is recorded', async () => {
    const since = await refusalsNow();
    const r = await api.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: { ...(await headers()), 'x-kf-acting-role': f.performerRoleId },
    });
    expect(r.statusCode, r.body).toBe(401);
    // A subject linked to nobody is refused too, and recorded nowhere (20260927000100).
    const unlinked = await api.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: await headers(await token({ subject: 'auth0|unlinked-searcher' })),
    });
    expect(unlinked.statusCode, unlinked.body).toBe(401);
    expect(await refusalsSince(since)).toEqual([
      expect.objectContaining({
        surface: 'search',
        failure: 'role_not_held',
        asker_kind: 'person',
        person_key: true,
      }),
    ]);
  });

  it('refuses a forged token at the door', async () => {
    const r = await api.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: await headers(await token({ issuer: 'https://evil.invalid/' })),
    });
    expect(r.statusCode, r.body).toBe(401);
    expect(r.json()).toMatchObject({ error: 'invalid_token' });
  });
});

interface RefusalRow extends Record<string, unknown> {
  organization_id: string;
  surface: string;
  failure: string;
  agent_client_id: string | null;
  asker_kind: string;
  asker_rank: number;
  person_key: boolean;
}

async function refusalsNow(): Promise<Date> {
  return (await withTransaction(h.adminPool, (tx) => tx.one<{ now: Date }>('select now() as now')))
    .now;
}

/** Every refusal recorded since `since`, oldest first, with whether its key is the reviewer's. */
async function refusalsSince(since: Date): Promise<RefusalRow[]> {
  return withTransaction(h.adminPool, (tx) =>
    tx.query<RefusalRow>(
      `select organization_id, surface, failure, agent_client_id, asker_kind, asker_rank,
              exists (select 1 from search.asker_key k
                       where r.asker_key = public.hmac(convert_to($2, 'UTF8'), k.key, 'sha256'))
                as person_key
         from search.identification_refusal r
        where recorded_at >= $1
        order by recorded_at, id`,
      [since, f.reviewerId],
    ),
  );
}

describe('a refusal before anybody is bound is recorded, attributably and naming nobody', () => {
  const on = (surface: string, over: Parameters<typeof asked>[1] = {}, ceiling = 'restricted') => ({
    ...asked('', over),
    maxClassification: ceiling,
    surface: surface as 'context-source/read',
  });

  it('records each refusal of a verified token on a named surface, under the asker pseudonym', async () => {
    const since = await refusalsNow();
    const refusals: [string, string][] = [];
    const attempt = async (request: ReturnType<typeof on>, bearer: string) => {
      const err = await attestor.identify({ ...request, token: bearer }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdentityRejected);
      refusals.push([request.surface, (err as IdentityRejected).failure]);
    };
    // The person's own role, a ceiling this database does not know; another's role; a delegated
    // token naming an agent nobody declared; a subject nobody linked, which is refused and, as
    // nobody of this organization, not recorded (20260927000100).
    await attempt(on('context-source/retrieve', {}, 'top-secret'), await token());
    await attempt(on('context-source/read', { actingRoleId: f.performerRoleId }), await token());
    await attempt(
      on('context-source/revision', {}, 'internal'),
      await token({ extra: { azp: 'rogue-agent', act: { client_id: 'rogue-agent' } } }),
    );
    await attempt(on('search'), await token({ subject: 'auth0|stranger-2' }));
    expect(refusals).toEqual([
      ['context-source/retrieve', 'classification_not_granted'],
      ['context-source/read', 'role_not_held'],
      ['context-source/revision', 'undeclared_agent'],
      ['search', 'unknown_subject'],
    ]);

    const rows = await refusalsSince(since);
    expect(rows).toEqual([
      {
        organization_id: f.organizationId,
        surface: 'context-source/retrieve',
        failure: 'classification_not_granted',
        agent_client_id: null,
        asker_kind: 'person',
        asker_rank: 3,
        person_key: true,
      },
      expect.objectContaining({
        surface: 'context-source/read',
        failure: 'role_not_held',
        asker_kind: 'person',
        asker_rank: 3,
        person_key: true,
      }),
      expect.objectContaining({
        surface: 'context-source/revision',
        failure: 'undeclared_agent',
        agent_client_id: 'rogue-agent',
        asker_kind: 'person',
        asker_rank: 1,
        person_key: true,
      }),
    ]);
  });

  it('records nothing for a token defect, an unnamed surface or an organization that does not exist', async () => {
    const since = await refusalsNow();
    for (const [request, bearer] of [
      [on('context-source/read'), await token({ issuer: 'https://evil.invalid/' })],
      [asked('', { actingRoleId: f.performerRoleId }), await token()],
      [
        on('context-source/read', { organizationId: '01930000-0000-7000-8000-0000000000ff' }),
        await token(),
      ],
    ] as const) {
      const err = await attestor.identify({ ...request, token: bearer }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdentityRejected);
    }
    expect(await refusalsSince(since)).toEqual([]);
  });

  it('is readable in the organization without the pseudonym, and writable only by the attestor', async () => {
    await expect(
      withTransaction(bareApp, async (tx) => {
        await bindPrincipal(tx, await attestor.identify(asked(await token())));
        return tx.query('select asker_key from search.identification_refusal');
      }),
    ).rejects.toThrow(/permission denied/u);
    const visible = await withTransaction(bareApp, async (tx) => {
      await bindPrincipal(tx, await attestor.identify(asked(await token())));
      return tx.query<{ failure: string }>(
        'select failure from search.identification_refusal order by recorded_at',
      );
    });
    expect(visible.length).toBeGreaterThan(0);
    await expect(
      withTransaction(bareApp, async (tx) => {
        await bindPrincipal(tx, await attestor.identify(asked(await token())));
        return tx.query(
          `select search.record_identification_refusal('i', 's', $1, 'public', 'search',
                                                       'unknown_subject', null)`,
          [f.organizationId],
        );
      }),
    ).rejects.toThrow(/permission denied/u);
  });
});

describe('a refusal is recorded only for a person of the organization named (20260927000100)', () => {
  let other: Fixtures;
  beforeAll(async () => {
    other = await seedFixtures(h.adminPool, { auditClearance: false });
  });

  /** The seam called as kf-attestor itself, or anything holding its login: no attestor in the way. */
  const seam = (issuer: string, subject: string, organization: string) =>
    withTransaction(h.attestorPool, (tx) =>
      tx.one<{ id: string | null }>(
        `select search.record_identification_refusal($1, $2, $3, 'restricted',
                                                     'context-source/read',
                                                     'classification_not_granted', null) as id`,
        [issuer, subject, organization],
      ),
    );

  it('writes no row for a subject linked to no person, through the attestor or around it', async () => {
    const since = await refusalsNow();
    const err = await attestor
      .identify({
        ...asked(await token({ subject: 'auth0|injector' })),
        surface: 'context-source/read',
      })
      .catch((e: unknown) => e);
    expect((err as IdentityRejected).failure).toBe('unknown_subject');
    expect((await seam(ISSUER, 'auth0|injector', f.organizationId)).id).toBeNull();
    expect((await seam(ISSUER, 'auth0|injector', other.organizationId)).id).toBeNull();
    expect(await refusalsSince(since)).toEqual([]);
  });

  it('writes no row for a linked person naming an organization they do not belong to', async () => {
    const since = await refusalsNow();
    const err = await attestor
      .identify({
        ...asked(await token(), { organizationId: other.organizationId }),
        surface: 'context-source/read',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityRejected);
    // `recorded` stays in the attestor process (its log line); across the socket, the rows speak.
    expect((err as IdentityRejected).failure).toBe('role_not_held');
    // In the attestor's own process, the refusal says it was not recorded.
    const local = await new LocalAttestor(h.attestorPool, verifierForFlaky)
      .identify({
        ...asked(await token(), { organizationId: other.organizationId }),
        surface: 'context-source/read',
      })
      .catch((e: unknown) => e);
    expect((local as IdentityRejected).recorded).toBe(false);
    expect((await seam(ISSUER, 'auth0|reviewer', other.organizationId)).id).toBeNull();
    const rows = await withTransaction(h.adminPool, (tx) =>
      tx.query('select 1 from search.identification_refusal where organization_id = $1', [
        other.organizationId,
      ]),
    );
    expect(rows).toEqual([]);
    expect(await refusalsSince(since)).toEqual([]);
  });

  it('still writes the row for the same person in their own organization (the control)', async () => {
    const since = await refusalsNow();
    expect((await seam(ISSUER, 'auth0|reviewer', f.organizationId)).id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await refusalsSince(since)).toEqual([
      expect.objectContaining({
        organization_id: f.organizationId,
        failure: 'classification_not_granted',
        asker_kind: 'person',
        person_key: true,
      }),
    ]);
  });
});

describe('holdings: every assignment the token’s own person holds (20260926120000)', () => {
  const holdingsAnswer = (body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          path: '/holdings',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  it('lists the person’s organizations with their legal names, and attests nothing', async () => {
    const before = await attestationCount();
    const holdings = await attestor.holdings(await token());
    const { legal_name: legalName } = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ legal_name: string }>('select legal_name from org.organization where id = $1', [
        f.organizationId,
      ]),
    );
    expect(holdings).toEqual({
      personId: f.reviewerId,
      organizations: [
        {
          organizationId: f.organizationId,
          legalName,
          assignments: [
            {
              assignmentId: f.reviewerRoleId,
              roleId: 'technical_authority',
              scopeId: f.organizationId,
            },
          ],
        },
      ],
    });
    expect(await attestationCount()).toBe(before);
  });

  it('refuses a bad token as identify does, and an unlinked subject', async () => {
    for (const bad of [
      await token({ issuer: 'https://evil.invalid/' }),
      await token({ audience: 'some-other-service' }),
      await token({ expiresIn: '-1h' }),
      await token({ alg: 'RS512' }),
    ]) {
      const err = await attestor.holdings(bad).catch((e: unknown) => e);
      expect((err as IdentityRejected).failure).toBe('invalid_token');
    }
    const stranger = await attestor
      .holdings(await token({ subject: 'auth0|stranger' }))
      .catch((e: unknown) => e);
    expect((stranger as IdentityRejected).failure).toBe('unknown_subject');
    const empty = await attestor.holdings('  ').catch((e: unknown) => e);
    expect((empty as IdentityRejected).failure).toBe('no_token');
  });

  it('takes a token and nothing else: a request naming a person or organization is refused', async () => {
    const bearer = await token();
    expect(await holdingsAnswer(JSON.stringify({ token: bearer }))).toBe(200);
    expect(await holdingsAnswer(JSON.stringify({ token: bearer, personId: f.performerId }))).toBe(
      400,
    );
    expect(
      await holdingsAnswer(JSON.stringify({ token: bearer, organizationId: f.organizationId })),
    ).toBe(400);
    expect(await holdingsAnswer('{"token": 7}')).toBe(400);
  });

  it('serves GET /session/contexts to the application login, bound only through attestations', async () => {
    const api = Fastify({ logger: false });
    registerSessionRoutes(api, {
      pool: bareApp,
      identify: createCallerIdentifier(bareApp, attestor, { trustHeaders: false }),
      holdings: createHoldingsLister(bareApp, attestor, { trustHeaders: false }),
    });
    await api.ready();
    try {
      const r = await api.inject({
        method: 'GET',
        url: '/session/contexts',
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        personId: f.reviewerId,
        organizations: [
          {
            organizationId: f.organizationId,
            clearance: 'restricted',
            assignments: [{ assignmentId: f.reviewerRoleId, roleId: 'technical_authority' }],
            refused: null,
          },
        ],
      });
      const stranger = await api.inject({
        method: 'GET',
        url: '/session/contexts',
        headers: { authorization: `Bearer ${await token({ subject: 'auth0|stranger' })}` },
      });
      expect(stranger.statusCode).toBe(401);
      expect(stranger.json()).toMatchObject({ error: 'unknown_subject' });
    } finally {
      await api.close();
    }
  });
});

describe('an attestor that cannot be reached is an outage, not a refusal', () => {
  // The dogfood API with no attestor behind its socket. Every caller here holds a VALID token:
  // telling them 401 would send them round a login loop that cannot succeed, and a 500 would
  // page for a defect that is an outage. Fail closed with 503, and bind nobody.
  let api: FastifyInstance;
  let down: SocketAttestor;
  const changes: unknown[] = [];

  beforeAll(async () => {
    down = new SocketAttestor(join(socketDir, 'absent.sock'), {
      onAvailabilityChange: (state) => changes.push(state),
    });
    api = Fastify({ logger: false });
    const identify = createCallerIdentifier(bareApp, down, { trustHeaders: false });
    await registerSearchRoutes(api, { pool: bareApp, identify });
    const execute = createFabricDispatcher(
      bareApp,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: new PandocDocumentParser(),
      }),
    );
    await registerActionRoutes(api, {
      pool: bareApp,
      attestor: down,
      trustHeaders: false,
      execute,
    });
    registerVerificationRoutes(api, { execute, identify });
    await api.ready();
  });

  afterAll(async () => {
    await api?.close();
  });

  const headers = async () => ({
    authorization: `Bearer ${await token()}`,
    'x-kf-acting-role': f.reviewerRoleId,
    'x-kf-organization': f.organizationId,
    'x-kf-classification': 'restricted',
  });

  it('identify throws AttestorUnavailable naming the socket, not a generic error', async () => {
    const err = await down.identify(asked(await token())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttestorUnavailable);
    expect((err as AttestorUnavailable).reason).toBe('ENOENT');
    expect((err as AttestorUnavailable).socketPath).toBe(join(socketDir, 'absent.sock'));
  });

  it.each([
    ['a read', 'GET', '/search?q=anything', undefined],
    [
      'an action',
      'POST',
      '/actions/create_initiative',
      { idempotencyKey: 'attestor-down-0001', payload: { title: 'x' } },
    ],
    [
      'a bulk verification',
      'POST',
      '/verifications/bulk',
      { recordIds: [], reason: 'while the attestor is down', idempotencyKey: 'attestor-down-2' },
    ],
  ] as const)('answers %s 503 attestor_unavailable', async (_what, method, url, payload) => {
    const r = await api.inject({
      method,
      url,
      headers: await headers(),
      ...(payload === undefined ? {} : { payload }),
    });
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: 'attestor_unavailable' });
    expect(r.headers['retry-after']).toBe('5');
    // The socket path is for the operator's log, never the caller.
    expect(r.body).not.toContain(socketDir);
  });

  it('reports the outage once, with the socket path, however many requests it refuses', () => {
    expect(changes).toEqual([
      { available: false, socketPath: join(socketDir, 'absent.sock'), reason: 'ENOENT' },
    ]);
  });

  it('a live attestor that does not answer in time is unavailable too', async () => {
    const hangingPath = join(socketDir, 'hanging.sock');
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(hangingPath, resolve));
    try {
      const slow = new SocketAttestor(hangingPath, { timeoutMillis: 100 });
      const err = await slow.identify(asked(await token())).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AttestorUnavailable);
      expect((err as AttestorUnavailable).reason).toBe('timeout');
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it('an attestor answering 5xx is unavailable; back up, it is reported once more', async () => {
    const flakyPath = join(socketDir, 'flaky.sock');
    let failing = true;
    const inner = createAttestorServer(new LocalAttestor(h.attestorPool, verifierForFlaky));
    const flaky = createServer((req, res) => {
      if (failing) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"failure":"unavailable"}');
        return;
      }
      inner.emit('request', req, res);
    });
    await new Promise<void>((resolve) => flaky.listen(flakyPath, resolve));
    const seen: unknown[] = [];
    try {
      const client = new SocketAttestor(flakyPath, {
        onAvailabilityChange: (state) => seen.push(state.available),
      });
      const err = await client.identify(asked(await token())).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AttestorUnavailable);
      expect((err as AttestorUnavailable).reason).toBe('status 500');
      failing = false;
      expect((await client.identify(asked(await token()))).actorId).toBe(f.reviewerId);
      expect(seen).toEqual([false, true]);
    } finally {
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
    }
  });

  it('a token the attestor refuses is still 401, not 503', async () => {
    const r = await new SocketAttestor(socketPath)
      .identify(asked(await token({ issuer: 'https://evil.invalid/' })))
      .catch((e: unknown) => e);
    expect(r).toBeInstanceOf(IdentityRejected);
    expect(r).not.toBeInstanceOf(AttestorUnavailable);
  });
});
