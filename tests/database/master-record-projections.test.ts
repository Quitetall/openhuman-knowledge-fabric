import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms, latestMasterRecord } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions, type ProjectionResult } from '@kf/projections';
import { registerMasterRecordProjectionRoute } from '../../apps/api/src/routes/documents/master-record-projection-route.js';
import { registerMasterRecordRoute } from '../../apps/api/src/routes/documents/master-record-route.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import {
  bindContext,
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
      expect(result.format).toBe('kf-projection-result-v1');
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
      expect(html.body).toContain('<h2>Raw corpus</h2>');
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
});
