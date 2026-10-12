/**
 * The web's qualification gestures, as the API offers them (SAS §100.62; ADR 0038; KF-SAS-RQ-254,
 * RQ-061).
 *
 * `GET /qualification/records/:id/gestures` answers which institutional acts on a record the
 * reader may perform now, and `GET /qualification/packs/drafting` whether they may draft a pack and
 * what a draft may compose. Both answers are the real dispatcher's preflight, as the caller — the
 * web renders a gesture only where the answer offers it, and never decides from a role. So:
 *
 *   - a reader with act authority over the record is offered withdraw and supersede, with the
 *     person's other records in force to choose from; one who can read the record (its contact)
 *     but holds no act authority over it is offered neither; an agent acting for a person is
 *     offered nothing; a reader who cannot read the record gets the record's 404;
 *   - the API stays the authority: the act a gesture would dispatch is refused to the reader not
 *     offered it, and performed for the one who is, after which nothing more is offered;
 *   - the drafting answer's parts are exactly what the act resolves: a document the web validates
 *     clean with them is drafted, and one naming a pack that is not there fails both.
 *
 * FALSIFIED in-file: the same routes given a preflight that refuses nothing offer the contact the
 * withdrawal, so "offered neither" is an assertion about the preflight and not about the setup.
 */

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionalActionPreflight } from '@kf/actions';
import type { JsonValue } from '@kf/canonicalization';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  validatePackDocument,
  type PackDocument,
  type PartRef,
  type ResolvedPart,
} from '@kf/qualification';
import type { Caller } from '../../apps/api/src/routes/actions/contracts.js';
import { registerActionPostRoute } from '../../apps/api/src/routes/actions/write-route.js';
import { DEFAULT_EFFECTIVE_AT_BOUNDS } from '../../apps/api/src/routes/actions/effective-at.js';
import { registerQualificationRoutes } from '../../apps/api/src/routes/qualification.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';
import { enrolPerson, fixtureProject } from './people.js';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;

interface Who {
  readonly id: string;
  readonly role: string;
  readonly agent?: string;
}
let reviewer: Who;
let contact: Who;
let outsider: Who;
let person: Who;
let resource: string;
let packKey: string;
/** Records for `person`: A and B with the reviewer as contact, C with `contact` as contact. */
let recordA: string;
let recordB: string;
let recordC: string;

const caller = (who: Who): Caller => ({
  actorId: who.id,
  actingRoleId: who.role,
  organizationId: f.organizationId,
  maxClassification: 'restricted',
  authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  ...(who.agent === undefined ? {} : { agent: who.agent }),
});

async function api(
  who: Who,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  preflight?: TransactionalActionPreflight,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = Fastify({ logger: false });
  const identify = async () => caller(who);
  registerQualificationRoutes(server, {
    pool: h.pool,
    execute,
    identify,
    ...(preflight === undefined ? {} : { preflight }),
  });
  registerActionPostRoute(server, {
    execute,
    identify,
    stepUp: {},
    verifier: undefined,
    effectiveAtBounds: DEFAULT_EFFECTIVE_AT_BOUNDS,
  });
  await server.ready();
  try {
    const response = await server.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  } finally {
    await server.close();
  }
}

const act = (
  who: Who,
  actionType: string,
  targetIds: string[],
  payload: Record<string, JsonValue>,
) =>
  execute({
    actionType,
    actorId: who.id,
    actingRoleId: who.role,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    targetIds,
    payload,
    idempotencyKey: `gestures-${randomUUID()}`,
  });

async function revision(objectId: string): Promise<string> {
  const row = await withTransaction(h.adminPool, (tx) =>
    tx.one<{ row_version: string }>('select row_version::text from core.object where id = $1', [
      objectId,
    ]),
  );
  return row.row_version;
}

function pack(key: string, parts?: PackDocument['parts']): PackDocument {
  return {
    format: 'kf-qualification-pack-v1',
    key,
    revision: 1,
    title: `Pack ${key}`,
    owner: 'role:technical_authority',
    closing: 'on_evidence',
    ...(parts === undefined ? {} : { parts }),
    requirements: [
      {
        key: `${key}.read`,
        revision: 1,
        part: 'role',
        stage: 'read_in',
        outcome: 'Has read the procedures index',
        evidence_mode: 'acknowledge',
        accepted_by: 'self',
        mandatory: false,
        resources: [{ id: resource, revision: currentRevision, authority_class: 'normative' }],
      },
      // Accepted by the reviewer's role, so the reviewer reviews this pack and reads its records.
      // (An assigner who cannot read the record it assigns has `assign_qualification` fail at its
      // receipt, which reads the record under the assigner's row security; reported, not fixed
      // here.)
      {
        key: `${key}.locate`,
        revision: 1,
        part: 'role',
        stage: 'references',
        outcome: 'Knows where the procedures index lives',
        evidence_mode: 'locate',
        accepted_by: 'role:technical_authority',
        mandatory: false,
      },
    ],
  };
}
let currentRevision: string;

const gestures = (who: Who, recordId: string, preflight?: TransactionalActionPreflight) =>
  api(who, 'GET', `/qualification/records/${recordId}/gestures`, undefined, preflight);

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(h.pool);
  const project = await fixtureProject(h.adminPool, f, 'A project the contact is scoped to');
  const enrol = async (name: string, role: string, scopeId?: string): Promise<Who> => {
    const enrolled = await enrolPerson(h.adminPool, f, {
      name,
      assignments: [{ role, ...(scopeId === undefined ? {} : { scopeId }) }],
    });
    return { id: enrolled.personId, role: enrolled.assignmentIds[0]! };
  };
  reviewer = { id: f.reviewerId, role: f.reviewerRoleId };
  // Holds one project only: a live assignment (so may be a contact), and no act over a record.
  contact = await enrol('Cora Contact', 'performer', project);
  person = await enrol('Pia Person', 'performer');
  outsider = await enrol('Otto Outsider', 'performer', project);
  resource = await createObject(h.adminPool, f, {
    type: 'controlled_document',
    domain: 'qms',
    state: 'draft',
    title: 'Procedures index',
    createdBy: f.reviewerId,
  });
  currentRevision = await revision(resource);
  packKey = 'gestures.base';
  const drafted = await act(reviewer, 'draft_qualification_pack', [], {
    document: pack(packKey) as unknown as JsonValue,
  });
  const packId = String(drafted.receipt?.['packId']);
  await act(reviewer, 'approve_qualification_pack', [packId], {});
  const assign = async (contactId: string, scope?: string) =>
    String(
      (
        await act(reviewer, 'assign_qualification', [], {
          person_id: person.id,
          pack_id: packId,
          contact_person_id: contactId,
          ...(scope === undefined ? {} : { scope_object_id: scope }),
        })
      ).receipt?.['recordId'],
    );
  recordA = await assign(reviewer.id);
  recordB = await assign(reviewer.id, project);
  recordC = await assign(contact.id);
}, 900_000);

afterAll(async () => {
  await h?.stop();
});

describe('the gestures a record offers its reader', () => {
  it('offers withdraw and supersede to a reader with act authority over it', async () => {
    const { status, body } = await gestures(reviewer, recordA);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      format: 'kf-qualification-record-gestures-v1',
      recordId: recordA,
      state: 'assigned',
      withdraw: { available: true },
      supersede: { available: true },
    });
    const candidates = (body['supersede'] as { candidates: { recordId: string }[] }).candidates;
    expect(candidates.map((c) => c.recordId)).toContain(recordB);
    expect(candidates.map((c) => c.recordId)).not.toContain(recordA);
  });

  it('offers nothing to the contact, who reads the record and holds no act over it', async () => {
    expect((await api(contact, 'GET', `/qualification/records/${recordC}`)).status).toBe(200);
    const { status, body } = await gestures(contact, recordC);
    expect(status).toBe(200);
    expect(body['withdraw']).toEqual({ available: false });
    expect(body['supersede']).toEqual({ available: false, candidates: [] });
  });

  it('answers only because the preflight refuses: a preflight that refuses nothing offers it', async () => {
    const permissive: TransactionalActionPreflight = async () => {};
    const { body } = await gestures(contact, recordC, permissive);
    expect(body['withdraw']).toEqual({ available: true });
  });

  it('offers an agent acting for the reviewer nothing, and a stranger the record’s 404', async () => {
    const { body } = await gestures({ ...reviewer, agent: 'web-agent' }, recordA);
    expect(body['withdraw']).toEqual({ available: false });
    expect(body['supersede']).toEqual({ available: false, candidates: [] });
    expect((await gestures(outsider, recordA)).status).toBe(404);
    expect((await gestures(outsider, randomUUID())).status).toBe(404);
  });

  it('leaves the API the authority: the contact is refused the act, the reviewer performs it', async () => {
    const refused = await api(contact, 'POST', '/actions/withdraw_qualification', {
      targetIds: [recordC],
      reason: 'the contact tries to withdraw it',
      idempotencyKey: `gestures-${randomUUID()}`,
    });
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('act_not_granted');

    const superseded = await api(reviewer, 'POST', '/actions/supersede_qualification', {
      targetIds: [recordC],
      payload: { superseded_by: recordB },
      reason: 'a scoped record replaces the organization-wide one',
      idempotencyKey: `gestures-${randomUUID()}`,
    });
    expect(superseded.status).toBe(201);

    const withdrawn = await api(reviewer, 'POST', '/actions/withdraw_qualification', {
      targetIds: [recordA],
      reason: 'assigned in error, before the person started',
      idempotencyKey: `gestures-${randomUUID()}`,
    });
    expect(withdrawn.status).toBe(201);
    // Terminal: the state machine has no way on, and the answer says so.
    const after = await gestures(reviewer, recordA);
    expect(after.body).toMatchObject({
      state: 'withdrawn',
      withdraw: { available: false },
      supersede: { available: false, candidates: [] },
    });
  });
});

describe('drafting a pack', () => {
  it('offers drafting, and the parts the act would resolve, which validate a draft that is then drafted', async () => {
    const { status, body } = await api(reviewer, 'GET', '/qualification/packs/drafting');
    expect(status).toBe(200);
    expect(body['format']).toBe('kf-qualification-pack-drafting-v1');
    expect(body['draft']).toEqual({ available: true });
    expect(body['roles']).toEqual(expect.arrayContaining(['technical_authority', 'performer']));
    const parts = body['parts'] as ResolvedPart[];
    const base = parts.find((p) => p.key === packKey && p.revision === 1);
    expect(base).toMatchObject({ approved: true, composesParts: false });
    expect(base?.requirements.map((r) => r.key)).toEqual([`${packKey}.locate`, `${packKey}.read`]);

    const resolve = (ref: PartRef) =>
      parts.find((p) => p.key === ref.pack && p.revision === ref.revision);
    const composed = pack('gestures.composed', { common: [{ pack: packKey, revision: 1 }] });
    expect(validatePackDocument(composed, resolve).problems).toEqual([]);
    const drafted = await api(reviewer, 'POST', '/actions/draft_qualification_pack', {
      payload: { document: composed },
      idempotencyKey: `gestures-${randomUUID()}`,
    });
    expect(drafted.status).toBe(201);

    const dead = pack('gestures.dead', { common: [{ pack: 'gestures.absent', revision: 1 }] });
    expect(validatePackDocument(dead, resolve).problems.map((p) => p.code)).toContain(
      'dead_reference',
    );
    const refused = await api(reviewer, 'POST', '/actions/draft_qualification_pack', {
      payload: { document: dead },
      idempotencyKey: `gestures-${randomUUID()}`,
    });
    expect(refused.status).toBe(422);
    expect(String(refused.body['message'])).toMatch(/dead_reference/);
  });

  it('offers an agent acting for a person no drafting', async () => {
    const { body } = await api(
      { ...reviewer, agent: 'web-agent' },
      'GET',
      '/qualification/packs/drafting',
    );
    expect(body['draft']).toEqual({ available: false });
  });
});
