/**
 * `POST /capture/observation` — one gesture, and the server forms everything else
 * (ADR 0034 §2, KF-SAS-RQ-200, RQ-203).
 *
 * Two apps against one real database:
 *
 *   dev     the development profile, header identity attested in-process — what `pnpm dev`
 *           serves, and what the web form reaches in development;
 *   bearer  the production shape: a bare `kf_app` login with no attestation issuer, and the
 *           caller attested by the real kf-attestor server over a real Unix socket. Here the
 *           assignment is derived by the ATTESTOR, from the verified token, and the derived
 *           request crosses the socket; the route works only if all of that does.
 *
 * What is asserted is the requirement's text: the request carries the note and nothing about
 * authority, concurrency or idempotency, and the act the ledger holds names the assignment, key
 * and target the server formed. A retried gesture replays. Ambiguity is refused and listed, never
 * guessed.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, type JWK } from 'jose';
import { InMemoryObjectStore } from '@kf/artifacts';
import { LocalAttestor, SocketAttestor, TokenVerifier, linkIdentity } from '@kf/authorization';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import { createAttestorServer } from '../../apps/attestor/src/server.js';
import { buildApp } from '../../apps/api/src/app.js';
import { createCallerIdentifier } from '../../apps/api/src/routes/actions.js';
import { CAPTURE_BODY_FIELDS, registerCaptureRoutes } from '../../apps/api/src/routes/capture.js';
import {
  bindContext,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';
import { enrolPerson, fixtureProject, type EnrolledPerson } from '../database/people.js';

const ISSUER = 'https://id.openhuman.invalid/realms/openhuman';
const AUDIENCE = 'knowledge-fabric';

let h: Harness;
let f: Fixtures;
let dev: FastifyInstance;
let bearer: FastifyInstance;
let bareApp: Pool;
let server: Server;
let socketDir: string;
let privateKey: KeyObject;
/** One live assignment, scoped to a project: no act over the organization. */
let noter: EnrolledPerson;
/** Two live assignments. */
let twoHats: EnrolledPerson;
/** Known, and holding nothing live. */
let nobody: EnrolledPerson;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function token(subject: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** Header identity with NO acting role: the person, the organization, the ceiling. */
const as = (person: EnrolledPerson, extra: Record<string, string> = {}) => ({
  'x-kf-actor': person.personId,
  'x-kf-organization': f.organizationId,
  'x-kf-classification': 'restricted',
  ...extra,
});

const bearerAs = async (subject: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${await token(subject)}`,
  'x-kf-organization': f.organizationId,
  'x-kf-classification': 'restricted',
  ...extra,
});

async function recordedAct(actionId: string) {
  return withTransaction(h.adminPool, (tx) =>
    tx.one<{
      action_type: string;
      actor_id: string;
      acting_role_id: string;
      idempotency_key: string;
      target_ids: string[];
    }>(
      `select action_type, actor_id, acting_role_id, idempotency_key, target_ids::text[] as target_ids
         from core.action where id = $1`,
      [actionId],
    ),
  );
}

const observationCount = () =>
  withTransaction(h.adminPool, async (tx) =>
    Number(
      (
        await tx.one<{ n: string }>(
          `select count(*)::text as n from core.object where object_type = 'observation'`,
        )
      ).n,
    ),
  );

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const project = await fixtureProject(h.adminPool, f, 'Capture bench');
  noter = await enrolPerson(h.adminPool, f, {
    name: 'Bench engineer',
    assignments: [{ role: 'performer', scopeId: project }],
  });
  twoHats = await enrolPerson(h.adminPool, f, {
    name: 'Engineer and reviewer',
    assignments: [{ role: 'performer', scopeId: project }, { role: 'reviewer' }],
  });
  nobody = await enrolPerson(h.adminPool, f, { name: 'Unassigned', assignments: [] });

  dev = await buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: process.env['LOG_LEVEL'] ?? 'silent',
      databaseUrl: h.developmentDatabaseUrl,
      environment: 'test',
      deploymentProfile: 'development',
      tlsTerminatedUpstream: false,
      identity: undefined,
    },
    { objectStore: new InMemoryObjectStore() },
  );
  await dev.ready();

  // The production shape: kf-attestor over a socket, the API as kf_app and nothing else.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key' };
  const verifier = new TokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    for (const [subject, person] of [
      ['auth0|noter', noter],
      ['auth0|two-hats', twoHats],
      ['auth0|nobody', nobody],
    ] as const) {
      await linkIdentity(tx, {
        issuer: ISSUER,
        subject,
        personId: person.personId,
        providerLabel: subject,
        linkedBy: f.reviewerId,
      });
    }
  });
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role kf_capture_test_api login password 'test-only-not-a-secret'`);
    await tx.query('grant kf_app to kf_capture_test_api');
    await tx.query('grant connect on database kf_test to kf_capture_test_api');
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_capture_test_api';
  uri.password = 'test-only-not-a-secret';
  bareApp = createPool({ connectionString: uri.toString(), maxConnections: 3 });
  socketDir = mkdtempSync(join(tmpdir(), 'kf-capture-attestor-'));
  const socketPath = join(socketDir, 'attestor.sock');
  server = createAttestorServer(new LocalAttestor(h.attestorPool, verifier));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  bearer = Fastify({ logger: false });
  registerCaptureRoutes(bearer, {
    pool: bareApp,
    execute: createFabricDispatcher(bareApp),
    identify: createCallerIdentifier(bareApp, new SocketAttestor(socketPath), {
      trustHeaders: false,
    }),
  });
  await bearer.ready();
}, 180_000);

afterAll(async () => {
  await dev?.close();
  await bearer?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
  await bareApp?.end();
  await h?.stop();
});

describe('the request carries the note and nothing about authority (RQ-200)', () => {
  it('needs no role, key or version, and the server forms all three', async () => {
    const payload = {
      body: 'Board B channel 3 noise floor 2.1 µV RMS.',
      gesture_id: 'g-rq200-0001',
    };
    // The whole request: no acting role header, and a body of the accepted fields only.
    for (const key of Object.keys(payload)) expect(CAPTURE_BODY_FIELDS.has(key)).toBe(true);
    const headers = as(noter);
    expect(Object.keys(headers)).not.toContain('x-kf-acting-role');
    for (const forbidden of ['actingRoleId', 'idempotencyKey', 'expectedVersion', 'targetIds']) {
      expect(payload).not.toHaveProperty(forbidden);
    }

    const res = await dev.inject({ method: 'POST', url: '/capture/observation', headers, payload });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as {
      observationId: string;
      actionId: string;
      replayed: boolean;
      gestureId: string;
      actingRoleId: string;
      lifecycleState: string;
      verification: { verified: boolean; label: string };
    };
    expect(body).toMatchObject({
      replayed: false,
      gestureId: 'g-rq200-0001',
      actingRoleId: noter.assignmentIds[0],
      lifecycleState: 'captured',
      verification: { verified: false, label: 'UNVERIFIED — nobody has checked this record' },
    });

    // The ledger holds what the SERVER formed: the only live assignment, gesture + digest, and
    // the observation as the act's product.
    const act = await recordedAct(body.actionId);
    expect(act).toEqual({
      action_type: 'record_observation',
      actor_id: noter.personId,
      acting_role_id: noter.assignmentIds[0],
      idempotency_key: `observation:g-rq200-0001:${sha256(payload.body)}`,
      // The target the server formed: the observation the act created, named on the act.
      target_ids: [body.observationId],
    });
    const created = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ created_by: string; object_type: string }>(
        'select created_by, object_type from core.object where id = $1',
        [body.observationId],
      ),
    );
    expect(created).toEqual({ created_by: noter.personId, object_type: 'observation' });
  });

  it('replays a retried gesture instead of capturing twice', async () => {
    const payload = { body: 'Retried: ADC clock jitter 40 ps.', gesture_id: 'g-rq200-retry' };
    const first = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(noter),
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const before = await observationCount();
    const again = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(noter),
      payload,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      replayed: true,
      observationId: (first.json() as { observationId: string }).observationId,
      actionId: (first.json() as { actionId: string }).actionId,
    });
    expect(await observationCount()).toBe(before);
  });

  it('generates a gesture id when none is sent, and returns it so the gesture can be retried', async () => {
    const note = 'Generated gesture: bias drift 3 µV/h.';
    const first = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(noter),
      payload: { body: note },
    });
    expect(first.statusCode, first.body).toBe(201);
    const { gestureId, observationId } = first.json() as {
      gestureId: string;
      observationId: string;
    };
    expect(gestureId).toMatch(/^[0-9a-f-]{36}$/);
    const retry = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(noter),
      payload: { body: note, gesture_id: gestureId },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: true, observationId });
  });

  it('refuses a body that tries to supply what the server forms, and records nothing', async () => {
    const before = await observationCount();
    for (const extra of [
      { idempotencyKey: 'caller-chosen-key' },
      { actingRoleId: noter.assignmentIds[0] },
      { expectedVersion: 1 },
      { targetIds: [] },
    ]) {
      const res = await dev.inject({
        method: 'POST',
        url: '/capture/observation',
        headers: as(noter),
        payload: { body: 'should not land', ...extra },
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'unknown_field', field: Object.keys(extra)[0] });
    }
    expect(await observationCount()).toBe(before);
  });

  it('refuses a subject in another organization exactly as one that does not exist, and records nothing', async () => {
    // A real second organization, and a record in it its own performer captured.
    const other = await seedFixtures(h.adminPool, { auditClearance: false });
    const foreign = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: {
        'x-kf-actor': other.performerId,
        'x-kf-organization': other.organizationId,
        'x-kf-classification': 'restricted',
        'x-kf-acting-role': other.performerRoleId,
      },
      payload: { body: 'Another organization’s note.', gesture_id: 'g-foreign-subject' },
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    const foreignId = (foreign.json() as { observationId: string }).observationId;

    const before = await observationCount();
    const refusals: unknown[] = [];
    for (const [label, subject] of [
      ['foreign', foreignId],
      ['nowhere', '01a0d6d3-0000-7000-8000-000000000000'],
    ] as const) {
      const res = await dev.inject({
        method: 'POST',
        url: '/capture/observation',
        headers: as(noter),
        payload: { body: `About ${label}.`, subjects: [subject], gesture_id: `g-subject-${label}` },
      });
      // Not found — never forbidden, never a 500 — and the same answer for both.
      expect(res.statusCode, `${label}: ${res.body}`).toBe(404);
      refusals.push(res.json());
    }
    expect(refusals[0]).toEqual(refusals[1]);
    expect(refusals[0]).toMatchObject({ error: 'object_not_visible' });
    expect(await observationCount()).toBe(before);
  });
});

describe('the assignment is formed, never guessed', () => {
  it('refuses a person with several live assignments who named none, listing them, and records nothing', async () => {
    const before = await observationCount();
    const res = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(twoHats),
      payload: { body: 'Which hat was I wearing?' },
    });
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json() as {
      error: string;
      assignments: { assignmentId: string; roleId: string }[];
    };
    expect(body.error).toBe('acting_assignment_ambiguous');
    expect(body.assignments.map((a) => a.assignmentId).sort()).toEqual(
      [...twoHats.assignmentIds].sort(),
    );
    expect(await observationCount()).toBe(before);
  });

  it('records under the one they name in the header', async () => {
    const res = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(twoHats, { 'x-kf-acting-role': twoHats.assignmentIds[1]! }),
      payload: { body: 'Wearing the reviewer hat for this one.' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ actingRoleId: twoHats.assignmentIds[1] });
  });

  it('refuses somebody with no live assignment', async () => {
    const res = await dev.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: as(nobody),
      payload: { body: 'Nobody hears this.' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: 'no_live_assignment' });
  });
});

describe('bearer identity: the attestor derives the assignment across the socket', () => {
  it('captures for a token alone — no role, key or version anywhere in the request', async () => {
    const headers = await bearerAs('auth0|noter');
    expect(Object.keys(headers)).not.toContain('x-kf-acting-role');
    const res = await bearer.inject({
      method: 'POST',
      url: '/capture/observation',
      headers,
      payload: { body: 'Bearer capture: reference electrode lifted.', gesture_id: 'g-bearer-001' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { actionId: string; actingRoleId: string };
    expect(body.actingRoleId).toBe(noter.assignmentIds[0]);
    expect((await recordedAct(body.actionId)).acting_role_id).toBe(noter.assignmentIds[0]);

    const again = await bearer.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: await bearerAs('auth0|noter'),
      payload: { body: 'Bearer capture: reference electrode lifted.', gesture_id: 'g-bearer-001' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, actionId: body.actionId });
  });

  it('carries the ambiguity refusal and its list back across the socket', async () => {
    const res = await bearer.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: await bearerAs('auth0|two-hats'),
      payload: { body: 'Which hat, over the socket?' },
    });
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json() as { error: string; assignments: { assignmentId: string }[] };
    expect(body.error).toBe('acting_assignment_ambiguous');
    expect(body.assignments.map((a) => a.assignmentId).sort()).toEqual(
      [...twoHats.assignmentIds].sort(),
    );
  });

  it('refuses a token whose person holds nothing live', async () => {
    const res = await bearer.inject({
      method: 'POST',
      url: '/capture/observation',
      headers: await bearerAs('auth0|nobody'),
      payload: { body: 'Nothing to act in.' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: 'no_live_assignment' });
  });

  it('still refuses an empty role on every other route', async () => {
    // Derivation is the capture route's alone: the identifier without the flag refuses.
    const identify = createCallerIdentifier(
      bareApp,
      new SocketAttestor(server.address() as string),
      {
        trustHeaders: false,
      },
    );
    await expect(identify({ headers: await bearerAs('auth0|noter') })).rejects.toMatchObject({
      failure: 'no_role_requested',
    });
  });
});
