import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms, latestMasterRecord } from '@kf/documents';
import { createFabricDispatcher, createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { UNVERIFIED_LABEL } from '@kf/domain';
import { loadProjectionDefinitions, type ProjectionResult } from '@kf/projections';
import { agentContextReader } from '../../apps/api/src/routes/documents/agent-context.js';
import { registerMasterRecordProjectionRoute } from '../../apps/api/src/routes/documents/master-record-projection-route.js';
import { registerObjectViewRoute } from '../../apps/api/src/routes/documents/object-view-route.js';
import { registerMasterRecordRoute } from '../../apps/api/src/routes/documents/master-record-route.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import {
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * One engine, every surface (ADR 0013). The pack-shipped definitions are read from the
 * compiled artifact exactly as the API does, and driven through the real routes against a real
 * database: the JSON target is the canonical Result, markdown and html are renderings of it
 * with the same projection digest, and GET /master-record's section labels come from the same
 * `master_sections` evaluation rather than a second implementation.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

function routeOptions(): DocumentRoutesOptions {
  return {
    pool: harness.pool,
    projections: loadProjectionDefinitions(ARTIFACT),
    identify: async () => ({
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    store: undefined,
    preflightInTransaction: async () => undefined,
    executeInTransaction: async () => {
      throw new Error('a projection read does not execute an action');
    },
  };
}

describe('corpus projections over a real master record', () => {
  let probe: string;

  beforeAll(async () => {
    probe = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Projection probe',
      createdBy: fixtures.performerId,
    });
    const execute = createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: {
          async parse() {
            return undefined;
          },
        },
      }),
    );
    const compiled = await execute({
      actionType: 'compile_master_record',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [fixtures.performerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `projections-${randomUUID()}`,
      reason: `compile for projection reads ${randomUUID()}`,
    });
    expect(compiled.status).toBe('applied');
    // One anchoring edge so `reached` is non-trivial.
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.performerId);
      await tx.query(
        `insert into core.relation (relation_type, source_id, target_id, created_by)
         values ('produces', $1, $2, $1)`,
        [fixtures.performerId, probe],
      );
    });
  }, 180_000);

  it('serves the canonical Result, ⊆ the master, with the remainder present', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordProjectionRoute(app, routeOptions());
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/master-record/projections/master_sections',
      });
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json() as ProjectionResult;
      expect(result.format).toBe('kf-projection-result-v2');
      expect(result.sections.map((s) => s.id)).toEqual([
        'withdrawn',
        'your_record',
        'org_view',
        'raw_corpus',
      ]);
      expect(result.sections[1]!.members.map((m) => m.objectId)).toContain(probe);

      const record = await withTransaction(harness.adminPool, (tx) =>
        latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId),
      );
      const manifest = record?.['manifest'] as {
        included: readonly { objectId: string }[];
        withdrawn: readonly { objectId: string }[];
      };
      const master = new Set([...manifest.included, ...manifest.withdrawn].map((m) => m.objectId));
      const projected = result.sections.flatMap((s) => s.members.map((m) => m.objectId));
      expect(projected.every((id) => master.has(id))).toBe(true);
      expect(projected.length).toBe(master.size);
      expect(result.source.corpusDigest).toBe(String(record?.['corpus_digest']));
      expect(response.headers['x-kf-projection-digest']).toBe(result.projectionDigest);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('renders markdown and html from the same Result, same projection digest', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordProjectionRoute(app, routeOptions());
    await app.ready();
    try {
      const json = await app.inject({
        method: 'GET',
        url: '/master-record/projections/raw_corpus',
      });
      const md = await app.inject({
        method: 'GET',
        url: '/master-record/projections/raw_corpus?format=markdown',
      });
      const html = await app.inject({
        method: 'GET',
        url: '/master-record/projections/raw_corpus?format=html',
      });
      expect([json.statusCode, md.statusCode, html.statusCode]).toEqual([200, 200, 200]);
      const digest = json.headers['x-kf-projection-digest'];
      expect(md.headers['x-kf-projection-digest']).toBe(digest);
      expect(html.headers['x-kf-projection-digest']).toBe(digest);
      expect(md.headers['content-type']).toBe('text/markdown');
      expect(md.body).toContain('## Raw corpus');
      expect(html.body).toContain('<h2>Raw corpus<small>');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('refuses a missing required parameter and an unknown one, by name', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordProjectionRoute(app, routeOptions());
    await app.ready();
    try {
      const missing = await app.inject({
        method: 'GET',
        url: '/master-record/projections/agent_context',
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ reason: 'missing_parameter' });
      const unknown = await app.inject({
        method: 'GET',
        url: '/master-record/projections/agent_context?token_budget=512&colour=red',
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ reason: 'unknown_parameter' });
      const ok = await app.inject({
        method: 'GET',
        url: '/master-record/projections/agent_context?token_budget=512',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((ok.json() as ProjectionResult).parameters).toEqual({ token_budget: 512 });
      const nope = await app.inject({ method: 'GET', url: '/master-record/projections/nope' });
      expect(nope.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('gives the AI planner the same agent_context Result the route serves (KF-SAS-RQ-115)', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordProjectionRoute(app, routeOptions());
    await app.ready();
    try {
      const served = await app.inject({
        method: 'GET',
        url: '/master-record/projections/agent_context?token_budget=512',
      });
      expect(served.statusCode, served.body).toBe(200);
      const outcome = await withTransaction(harness.pool, async (tx) => {
        await bindReader(tx, fixtures, fixtures.performerId);
        return agentContextReader(loadProjectionDefinitions(ARTIFACT))(
          tx,
          { actorId: fixtures.performerId, organizationId: fixtures.organizationId },
          512,
        );
      });
      expect(outcome.status).toBe('ready');
      const planned = (outcome as { projection: ProjectionResult }).projection;
      expect(planned.projectionDigest).toBe((served.json() as ProjectionResult).projectionDigest);
      expect(planned.sections.flatMap((s) => s.members.map((m) => m.objectId))).toContain(probe);

      // Without definitions, and for a person with no master record, it refuses rather than
      // handing the planner an empty or improvised context.
      const refused = await withTransaction(harness.pool, async (tx) => {
        await bindReader(tx, fixtures, fixtures.reviewerId);
        return {
          none: await agentContextReader(undefined)(
            tx,
            { actorId: fixtures.reviewerId, organizationId: fixtures.organizationId },
            512,
          ),
          noRecord: await agentContextReader(loadProjectionDefinitions(ARTIFACT))(
            tx,
            { actorId: fixtures.reviewerId, organizationId: fixtures.organizationId },
            512,
          ),
        };
      });
      expect(refused.none.status).toBe('projections_unavailable');
      expect(refused.noRecord.status).toBe('master_record_not_found');
    } finally {
      await app.close();
    }
  });

  it('labels GET /master-record items from the same master_sections evaluation', async () => {
    const app = Fastify({ logger: false });
    const options = routeOptions();
    registerMasterRecordRoute(app, options);
    registerMasterRecordProjectionRoute(app, options);
    await app.ready();
    try {
      const read = await app.inject({ method: 'GET', url: '/master-record' });
      expect(read.statusCode, read.body).toBe(200);
      const body = read.json() as {
        sections: { projectionDigest: string; sectionCounts: Record<string, number> };
        items: readonly { object_id: string; section: string }[];
      };
      const projected = await app.inject({
        method: 'GET',
        url: '/master-record/projections/master_sections',
      });
      const result = projected.json() as ProjectionResult;
      expect(body.sections.projectionDigest).toBe(result.projectionDigest);
      expect(body.items.find((i) => i.object_id === probe)?.section).toBe('your_record');
      expect(body.sections.sectionCounts['your_record']).toBe(
        body.items.filter((i) => i.section === 'your_record').length,
      );
    } finally {
      await app.close();
    }
  }, 60_000);

  it('never compiles on GET; refreshes a stale claim only on the POST, as an act', async () => {
    // The corpus moves under the viewer's claim. A GET is what a link is, and the web page
    // behind it is reachable by a cross-site navigation carrying the session cookie, so a GET
    // that compiled let any site make the reader perform a recorded act. The GET reports the
    // stale claim; the refresh POST compiles it — recorded, as them — and answers.
    await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Arrived after the claim',
      createdBy: fixtures.performerId,
    });
    const before = await withTransaction(harness.pool, async (tx) => {
      await bindReader(tx, fixtures, fixtures.performerId);
      return latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId);
    });
    const app = Fastify({ logger: false });
    registerObjectViewRoute(app, {
      ...routeOptions(),
      executeInTransaction: createFabricTransactionalDispatcher(
        createDocumentActionAtoms({
          store: new InMemoryObjectStore(),
          parser: {
            async parse() {
              return undefined;
            },
          },
        }),
      ),
    });
    await app.ready();
    try {
      const read = await app.inject({ method: 'GET', url: `/objects/${probe}` });
      expect(read.statusCode, read.body).toBe(409);
      expect(read.json()).toMatchObject({ error: 'master_record_stale' });
      const unchanged = await withTransaction(harness.pool, async (tx) => {
        await bindReader(tx, fixtures, fixtures.performerId);
        return latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId);
      });
      expect(unchanged?.['id']).toBe(before?.['id']);

      const response = await app.inject({ method: 'POST', url: `/objects/${probe}/refresh` });
      expect(response.statusCode, response.body).toBe(200);
      const after = await withTransaction(harness.pool, async (tx) => {
        await bindReader(tx, fixtures, fixtures.performerId);
        return latestMasterRecord(tx, fixtures.performerId, fixtures.organizationId);
      });
      expect(after?.['id']).not.toBe(before?.['id']);
      expect(String(after?.['corpus_digest'])).not.toBe(String(before?.['corpus_digest']));
    } finally {
      await app.close();
    }
  });

  it('serves an Object View: the anchor, its neighbourhood in both directions, plus facets', async () => {
    const app = Fastify({ logger: false });
    registerObjectViewRoute(app, routeOptions());
    await app.ready();
    try {
      // The probe is the TARGET of the edge inserted above (person -> probe), so from the
      // probe's side the person is a backlink. Anchored at the probe, the person must appear.
      const response = await app.inject({ method: 'GET', url: `/objects/${probe}` });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        result: ProjectionResult;
        facets: {
          history: { events: readonly { action_type: string }[] };
          availableActions: readonly { actionType: string }[];
        };
      };
      expect(body.result.definition.id).toBe('object_view');
      expect(body.result.sections.map((s) => s.id)).toEqual(['subject', 'relationships', 'other']);
      expect(body.result.sections[0]!.members.map((m) => m.objectId)).toEqual([probe]);
      expect(body.result.sections[1]!.members.map((m) => m.objectId)).toContain(
        fixtures.performerId,
      );
      expect(body.result.edges?.some((e) => e.relationType === 'produces')).toBe(true);
      // Members beyond one hop are scoped out and COUNTED, never silently absent.
      const placed = body.result.sections.reduce((n, s) => n + s.members.length, 0);
      expect(placed + body.result.measurements.excludedByFilter).toBe(
        body.result.measurements.corpusMemberCount,
      );
      // The probe was seeded by direct insert, so its own history is honestly empty; the facet
      // is proven on the person, whose compile_master_record action targets them.
      expect(Array.isArray(body.facets.history.events)).toBe(true);
      expect(Array.isArray(body.facets.availableActions)).toBe(true);
      const person = await app.inject({ method: 'GET', url: `/objects/${fixtures.performerId}` });
      expect(person.statusCode, person.body).toBe(200);
      const personView = person.json() as {
        facets: { history: { events: readonly { action_type: string }[] } };
      };
      expect(
        personView.facets.history.events.some((e) => e.action_type === 'compile_master_record'),
      ).toBe(true);
      expect(response.headers['x-kf-projection-digest']).toBe(body.result.projectionDigest);

      // An object outside the reader's corpus reads as not found — never as "exists elsewhere".
      const outside = await app.inject({
        method: 'GET',
        url: '/objects/019ff405-2eca-7e77-96cb-00990ac6f2ff',
      });
      expect(outside.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 60_000);
});

/**
 * KF-SAS-RQ-229 on every surface the projection engine feeds. One record is verified AFTER the
 * master record is compiled, so the label can only be right if it is read live under the
 * reader's row security rather than from the stored claim; the other is never verified.
 */
describe('verification, labelled wherever a record appears', () => {
  let checked: string;
  let unchecked: string;

  const documentAtoms = () =>
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });

  beforeAll(async () => {
    checked = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Checked by the reviewer',
      createdBy: fixtures.performerId,
    });
    unchecked = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Nobody has looked at this',
      createdBy: fixtures.performerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.performerId);
      await tx.query(
        `insert into core.relation (relation_type, source_id, target_id, created_by)
         values ('supersedes', $1, $2, $3)`,
        [checked, unchecked, fixtures.performerId],
      );
    });
    const execute = createFabricDispatcher(harness.pool, documentAtoms());
    const compiled = await execute({
      actionType: 'compile_master_record',
      actorId: fixtures.performerId,
      actingRoleId: fixtures.performerRoleId,
      targetIds: [fixtures.performerId],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `verification-compile-${randomUUID()}`,
      reason: `compile before verifying ${randomUUID()}`,
    });
    expect(compiled.status).toBe('applied');
    const verified = await execute({
      actionType: 'verify_record',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [checked],
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `verification-${randomUUID()}`,
      reason: 'read it against the source',
      payload: { basis: 'reviewed_individually' },
    });
    expect(verified.status).toBe('applied');
  }, 180_000);

  type Member = ProjectionResult['sections'][number]['members'][number];
  const find = (result: ProjectionResult, id: string): Member | undefined =>
    result.sections.flatMap((s) => s.members).find((m) => m.objectId === id);

  it('carries verified:false and the label, or the basis, in the projection JSON', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordProjectionRoute(app, routeOptions());
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/master-record/projections/raw_corpus',
      });
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json() as ProjectionResult;
      expect(find(result, unchecked)?.verification).toEqual({
        verified: false,
        label: UNVERIFIED_LABEL,
      });
      expect(find(result, checked)?.verification).toMatchObject({
        verified: true,
        basis: 'reviewed_individually',
        verifiedBy: fixtures.reviewerId,
      });
      expect(result.measurements.unverifiedCount).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('labels the unverified member in the markdown and html renderings', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordProjectionRoute(app, routeOptions());
    await app.ready();
    try {
      const md = await app.inject({
        method: 'GET',
        url: '/master-record/projections/raw_corpus?format=markdown',
      });
      const html = await app.inject({
        method: 'GET',
        url: '/master-record/projections/raw_corpus?format=html',
      });
      expect([md.statusCode, html.statusCode]).toEqual([200, 200]);
      const block = (body: string, id: string) =>
        body.slice(body.indexOf(id) - 400, body.indexOf(id) + 400);
      expect(md.body).toContain(`  - ${UNVERIFIED_LABEL}`);
      expect(md.body).toContain(`verified reviewed individually by ${fixtures.reviewerId}`);
      expect(html.body).toContain(`<div class="v unverified">${UNVERIFIED_LABEL}</div>`);
      expect(block(html.body, unchecked)).toContain('class="v unverified"');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('labels the Object View subject and each related record', async () => {
    const app = Fastify({ logger: false });
    registerObjectViewRoute(app, routeOptions());
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: `/objects/${checked}` });
      expect(response.statusCode, response.body).toBe(200);
      const { result } = response.json() as { result: ProjectionResult };
      expect(result.sections[0]!.members[0]!.verification).toMatchObject({
        verified: true,
        basis: 'reviewed_individually',
      });
      const related = result.sections[1]!.members.find((m) => m.objectId === unchecked);
      expect(related?.verification).toEqual({ verified: false, label: UNVERIFIED_LABEL });

      const other = await app.inject({ method: 'GET', url: `/objects/${unchecked}` });
      expect(other.statusCode, other.body).toBe(200);
      const subject = (other.json() as { result: ProjectionResult }).result.sections[0]!
        .members[0]!;
      expect(subject.verification).toEqual({ verified: false, label: UNVERIFIED_LABEL });
    } finally {
      await app.close();
    }
  }, 60_000);

  it('labels GET /master-record items too', async () => {
    const app = Fastify({ logger: false });
    registerMasterRecordRoute(app, routeOptions());
    await app.ready();
    try {
      const read = await app.inject({ method: 'GET', url: '/master-record' });
      expect(read.statusCode, read.body).toBe(200);
      const items = (
        read.json() as {
          items: readonly {
            object_id: string;
            verification: { verified: boolean; label: string };
          }[];
        }
      ).items;
      expect(items.find((i) => i.object_id === unchecked)?.verification).toEqual({
        verified: false,
        label: UNVERIFIED_LABEL,
      });
      expect(items.find((i) => i.object_id === checked)?.verification.verified).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);
});
