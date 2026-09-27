/**
 * An agent dispatches an act for a named person, end to end through the real seams (ADR 0035).
 *
 * The attestor is the real one — `createAttestorServer` over a Unix socket, `resolveCaller` under
 * the attestor's own database login — and the API side is the real `SocketAttestor`, route code
 * and dispatcher, connected as a bare `kf_app` login with NO attestation issuer registered. Tokens
 * have the shape Keycloak 26.4 issues through the realm's `act-client-id` mapper, measured against
 * the pinned image (docs/deployment/identity-and-login.md): `sub` the person, `azp` the agent
 * client, `act: { client_id: <the agent> }`.
 *
 * What must hold: an act dispatched on the exchanged token carries the agent's client id in
 * `core.action.agent_participation`; the same act on the person's own token carries null; a
 * forged `act`, a malformed or nested one, or one naming an undeclared client is refused by the
 * attestor, and nothing is attested.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
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
import { createPool, withTransaction, type Pool } from '@kf/database';
import { InMemoryObjectStore } from '@kf/artifacts';
import { PandocDocumentParser, createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { createAttestorServer } from '../../apps/attestor/src/server.js';
import { registerActionRoutes } from '../../apps/api/src/routes/actions.js';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import {
  bindContext,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

const ISSUER = 'https://id.openhuman.invalid/realms/openhuman';
const AUDIENCE = 'knowledge-fabric-api';
const PERSON = 'auth0|reviewer';
const WEB = 'knowledge-fabric-web';
const AGENT = 'knowledge-fabric-agent';

let h: Harness;
let f: Fixtures;
let privateKey: KeyObject;
let bareApp: Pool;
let server: Server;
let socketDir: string;
let attestor: SocketAttestor;
let api: FastifyInstance;

/** A token as the realm issues it: the person's own (`azp` the web client), or exchanged. */
async function token(claims: Record<string, unknown> = { azp: WEB }, key: KeyObject = privateKey) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(PERSON)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const exchanged = (): Promise<string> => token({ azp: AGENT, act: { client_id: AGENT } });

const asked = (bearer: string) => ({
  token: bearer,
  actingRoleId: f.reviewerRoleId,
  organizationId: f.organizationId,
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

let sequence = 0;
async function dispatch(bearer: string) {
  sequence += 1;
  return api.inject({
    method: 'POST',
    url: '/actions/create_initiative',
    headers: {
      authorization: `Bearer ${bearer}`,
      'x-kf-acting-role': f.reviewerRoleId,
      'x-kf-organization': f.organizationId,
      'x-kf-classification': 'restricted',
    },
    payload: {
      idempotencyKey: `agent-participation-${String(sequence).padStart(4, '0')}`,
      payload: {
        title: `Initiative ${sequence}`,
        objective: 'Drafted and dispatched for a named person.',
        sponsor_id: f.reviewerId,
      },
    },
  });
}

async function ledgerRow(actionId: string) {
  return withTransaction(h.adminPool, (tx) =>
    tx.one<{ actor_id: string; acting_role_id: string; agent_participation: string | null }>(
      'select actor_id, acting_role_id, agent_participation from core.action where id = $1',
      [actionId],
    ),
  );
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key' };
  const verifier = new TokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
    createLocalJWKSet({ keys: [publicJwk] }),
  );

  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await linkIdentity(tx, {
      issuer: ISSUER,
      subject: PERSON,
      personId: f.reviewerId,
      providerLabel: 'Reviewer',
      linkedBy: f.performerId,
    });
  });
  await runDeclareAgent(h.adminPool, {
    clientId: AGENT,
    declaredBy: f.reviewerId,
    reason: 'the agent under test acts for the reviewer',
    withdraw: false,
  });

  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role kf_agent_test_api login password 'test-only-not-a-secret'`);
    await tx.query('grant kf_app to kf_agent_test_api');
    await tx.query('grant connect on database kf_test to kf_agent_test_api');
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_agent_test_api';
  uri.password = 'test-only-not-a-secret';
  bareApp = createPool({ connectionString: uri.toString(), maxConnections: 3 });

  socketDir = mkdtempSync(join(tmpdir(), 'kf-agent-'));
  const socketPath = join(socketDir, 'attestor.sock');
  server = createAttestorServer(new LocalAttestor(h.attestorPool, verifier));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  attestor = new SocketAttestor(socketPath);

  api = Fastify({ logger: false });
  await registerActionRoutes(api, {
    pool: bareApp,
    attestor,
    trustHeaders: false,
    execute: createFabricDispatcher(
      bareApp,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: new PandocDocumentParser(),
      }),
    ),
  });
  await api.ready();
}, 180_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
  await bareApp?.end();
  await h?.stop();
});

describe('across the socket, the caller carries the agent', () => {
  it('an exchanged token comes back as the person, with the agent named', async () => {
    const caller = await attestor.identify(asked(await exchanged()));
    expect(caller.actorId).toBe(f.reviewerId);
    expect(caller.agent).toBe(AGENT);
  });

  it("the person's own token comes back with no agent", async () => {
    const caller = await attestor.identify(asked(await token()));
    expect(caller.actorId).toBe(f.reviewerId);
    expect(caller.agent).toBeUndefined();
  });
});

describe('the dispatched act', () => {
  it('through the exchange, is the person’s act with the agent’s participation recorded', async () => {
    const r = await dispatch(await exchanged());
    expect(r.statusCode, r.body).toBe(201);
    const row = await ledgerRow((r.json() as { actionId: string }).actionId);
    expect(row).toEqual({
      actor_id: f.reviewerId,
      acting_role_id: f.reviewerRoleId,
      agent_participation: AGENT,
    });
  });

  it('on the person’s own token, records no agent', async () => {
    const r = await dispatch(await token());
    expect(r.statusCode, r.body).toBe(201);
    const row = await ledgerRow((r.json() as { actionId: string }).actionId);
    expect(row.agent_participation).toBeNull();
    expect(row.actor_id).toBe(f.reviewerId);
  });
});

describe('the attestor refuses, and attests nothing', () => {
  const refusals: Array<[string, () => Promise<string>, string]> = [
    [
      'a forged act (signed by a key the issuer never published)',
      async () => {
        const other = await generateKeyPair('RS256', { extractable: true });
        return new SignJWT({ azp: AGENT, act: { client_id: AGENT } })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setSubject(PERSON)
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(other.privateKey);
      },
      'invalid_token',
    ],
    [
      'an act naming a client the token was not issued to',
      () => token({ azp: WEB, act: { client_id: AGENT } }),
      'invalid_token',
    ],
    [
      'a nested act',
      () => token({ azp: AGENT, act: { client_id: AGENT, act: { client_id: 'upstream-agent' } } }),
      'invalid_token',
    ],
    [
      'an act in the RFC 8693 sub form rather than the realm’s client_id',
      () => token({ azp: AGENT, act: { sub: AGENT } }),
      'invalid_token',
    ],
    [
      'an act naming an undeclared client',
      () => token({ azp: 'rogue-agent', act: { client_id: 'rogue-agent' } }),
      'undeclared_agent',
    ],
    ['a declared agent’s token without its act', () => token({ azp: AGENT }), 'undeclared_agent'],
  ];

  it.each(refusals)('refuses %s', async (_name, make, failure) => {
    const before = await attestationCount();
    const err = await attestor.identify(asked(await make())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityRejected);
    expect((err as IdentityRejected).failure).toBe(failure);
    expect(await attestationCount()).toBe(before);
  });

  it('and the route answers 401 with the failure, dispatching nothing', async () => {
    const before = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from core.action'),
    );
    const r = await dispatch(
      await token({ azp: 'rogue-agent', act: { client_id: 'rogue-agent' } }),
    );
    expect(r.statusCode, r.body).toBe(401);
    expect(r.json()).toMatchObject({ error: 'undeclared_agent' });
    const after = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from core.action'),
    );
    expect(after.n).toBe(before.n);
  });
});
