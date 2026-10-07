import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions, type ProjectionResult } from '@kf/projections';
import { registerObjectViewRoute } from '../../apps/api/src/routes/documents/object-view-route.js';
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
 * Every object type is browsable (KF-SAS-RQ-117, the Phase 7 exit).
 *
 * The Object View is generated from ontology metadata with no per-type code (ADR 0015), and the
 * acceptance test for that design is that EVERY type in `registry.object_type` answers
 * `GET /objects/:id` with an `object_view` Result anchored at the record. One record of each type
 * is made, and the set of types is read from the database, not listed here: a type added to the
 * ontology and not made below fails the coverage assertion rather than going unviewed.
 *
 * Records are made by their create acts wherever one act makes one. Two groups are not:
 *
 *   - BOOTSTRAP: organization, person and role_assignment have no dispatched create act
 *     (tests/conformance/create-act-coverage.test.ts says why); the harness fixtures made them.
 *   - FIXTURE: types whose create act presupposes a lifecycle walk of other records, or the
 *     document or ML pipelines. Their acts are exercised end to end elsewhere, named per type;
 *     here they are admin fixtures, because what is under test is the view, not the making.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');
const REFERENCE = 'tests/end-to-end/reference-scenario.test.ts';
const DOGFOOD = 'tests/end-to-end/document-dogfood.test.ts';

/**
 * Types made here by admin fixture, in their first declared state and their type's declared
 * authority domain, each with where its create act is proven instead.
 */
const FIXTURE: Readonly<
  Record<string, { readonly domain: string; readonly state: string; readonly proven: string }>
> = {
  work_order: { domain: 'commercial', state: 'draft', proven: REFERENCE },
  work_execution: { domain: 'commercial', state: 'draft', proven: REFERENCE },
  work_order_amendment: { domain: 'commercial', state: 'draft', proven: REFERENCE },
  acceptance_record: { domain: 'commercial', state: 'draft', proven: REFERENCE },
  invoice: { domain: 'finance', state: 'draft', proven: REFERENCE },
  payment: { domain: 'finance', state: 'planned', proven: REFERENCE },
  artifact: { domain: 'artifact', state: 'draft', proven: DOGFOOD },
  authored_fragment: { domain: 'qms', state: 'active', proven: DOGFOOD },
  document_composition: { domain: 'qms', state: 'active', proven: DOGFOOD },
  ml_promotion_decision: {
    domain: 'qms',
    state: 'recorded',
    proven: 'packages/integration/src/ml.test.ts',
  },
  // ADR 0038: drafted and assigned through their acts in the qualification suite.
  qualification_pack: {
    domain: 'organization',
    state: 'approved',
    proven: 'tests/database/qualification.test.ts',
  },
  qualification_record: {
    domain: 'organization',
    state: 'assigned',
    proven: 'tests/database/qualification.test.ts',
  },
};

let harness: Harness;
let fixtures: Fixtures;
/** One record per object type, by type. */
const made = new Map<string, string>();

/** A UUIDv7, which a warrant's identity must be (OpenWarrant SAS §12.2). */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
  made.set('organization', fixtures.organizationId);
  made.set('person', fixtures.reviewerId);
  made.set('role_assignment', fixtures.reviewerRoleId);

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
  /** Dispatch one create act as the technical authority and return the record it made. */
  const create = async (
    objectType: string,
    actionType: string,
    payload: Readonly<Record<string, unknown>>,
    targetIds: readonly string[] = [],
  ): Promise<string> => {
    const result = await execute({
      actionType,
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      targetIds,
      idempotencyKey: `browse-${actionType}-${randomUUID()}`,
      payload: payload as never,
    });
    expect(result.status, `${actionType}: ${JSON.stringify(result)}`).toBe('applied');
    const id = await withTransaction(harness.adminPool, async (tx) =>
      tx.maybeOne<{ id: string }>(
        'select id from core.object where id = any($1::uuid[]) and object_type = $2',
        [[...result.objectIds], objectType],
      ),
    );
    expect(id, `${actionType} made no ${objectType}`).toBeDefined();
    made.set(objectType, id!.id);
    return id!.id;
  };

  // A second organization: the engagement's counterparty and the supplier. Organizations are
  // the bootstrap tier's to make.
  const counterparty = await createObject(harness.adminPool, fixtures, {
    type: 'organization',
    domain: 'organization',
    state: 'active',
    title: 'Counterparty Ltd',
    createdBy: fixtures.reviewerId,
  });
  await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind)
       values ($1, $2, 'supplier')`,
      [counterparty, `Counterparty Ltd (${counterparty})`],
    );
  });

  // Work control.
  const project = await create('initiative_project', 'create_initiative', {
    title: 'Browsable project',
    objective: 'Every type answers its Object View.',
    sponsor_id: fixtures.reviewerId,
  });
  const workPackage = await create('work_package', 'create_work_package', {
    title: 'Browsable package',
    project_id: project,
    scope_statement: 'One of each record.',
    acceptance_criterion: 'Every view answers 200.',
  });
  await create('engagement', 'record_engagement', {
    title: 'Browsable engagement',
    counterparty,
    engagement_kind: 'contractor',
    starts_on: '2026-09-01',
  });
  await create('milestone', 'plan_milestone', {
    title: 'Browsable milestone',
    project_id: project,
    planned_on: '2026-12-01',
    criterion: 'Every view answers 200.',
  });
  await create('deliverable', 'define_deliverable', {
    title: 'Browsable deliverable',
    work_package_id: workPackage,
    description: 'A report that every view answers.',
    acceptance_criteria: ['Every view answers 200.'],
  });
  const decision = await create('decision_record', 'propose_decision', {
    title: 'Browsable decision',
  });
  await create('change_record', 'open_change', {
    title: 'Browsable change',
    decision_id: decision,
  });
  await create('warrant', 'create_warrant_draft', {
    warrant_uuid: uuidv7(),
    repository: 'openhuman-knowledge-fabric',
    title: 'Browsable warrant',
    profile: 'delivery',
    assurance_level: 'basic',
  });

  // Product, configuration and engineering.
  const product = await create('product_system', 'register_product_system', {
    title: 'Browsable product',
    product_kind: 'product',
    responsible_owner: fixtures.reviewerId,
  });
  const item = await create('configuration_item', 'promote_configuration_item', {
    title: 'Browsable board',
    item_kind: 'hardware',
    part_number: 'BRW-0001',
    revision_label: 'A',
    parent_system: product,
  });
  await create('interface_contract', 'publish_interface_contract', {
    title: 'Browsable connector',
    interface_kind: 'electrical',
    generation: 'gen1',
    provider: product,
    specification: 'A connector every view can show.',
  });
  await create('physical_binding', 'record_physical_binding', {
    title: 'Browsable unit',
    configuration_item: item,
    serial_number: 'BRW-SN-0001',
  });
  await create('baseline', 'define_baseline', {
    title: 'Browsable baseline',
    baseline_kind: 'product',
    contained_nodes: [item],
  });
  await create('release', 'define_release', {
    title: 'Browsable release',
    release_kind: 'product',
    contained_nodes: [item],
  });
  await create('requirement', 'define_requirement', {
    title: 'Browsable requirement',
    statement: 'Every object type SHALL answer its Object View.',
    requirement_kind: 'system',
  });
  const risk = await create('risk', 'identify_risk', {
    title: 'Browsable hazard',
    risk_kind: 'hazard',
    description: 'A type nobody can browse.',
  });
  const control = await create('risk_control', 'propose_risk_control', {
    title: 'Browsable control',
    control_kind: 'protective_measure',
    mitigates: risk,
    description: 'This test.',
  });
  const definition = await create('test_definition', 'define_test', {
    title: 'Browsable test definition',
    method_kind: 'test',
    acceptance_criterion: 'Every view answers 200.',
    verifies: control,
  });
  await create('test_execution', 'plan_test_execution', {
    title: 'Browsable test run',
    test_definition: definition,
    configuration_item: item,
  });
  await create('test', 'register_test', {
    title: 'Browsable protocol',
    test_kind: 'protocol',
    objective: 'Browse every type.',
  });

  // Quality.
  await create('controlled_document', 'submit_document_for_review', {
    title: 'Browsable procedure',
    document_class: 'procedure',
    document_number: 'OH-DOC-BROWSE',
    revision: 'R01',
    owning_role: 'technical_authority',
  });
  const nonconformity = await create('nonconformity', 'raise_nonconformity', {
    title: 'Browsable nonconformity',
    severity: 'minor',
    description: 'A record to browse.',
    subject_id: item,
  });
  await create('capa', 'open_capa', {
    title: 'Browsable CAPA',
    capa_kind: 'corrective',
    problem_statement: 'A record to browse.',
    effectiveness_criterion: 'It is browsable.',
    nonconformities: [nonconformity],
  });
  await create('supplier', 'register_supplier', {
    title: 'Browsable supplier',
    organization: counterparty,
    criticality: 'standard',
    scope_of_supply: 'Browsable parts.',
  });
  await create('equipment', 'register_equipment', {
    title: 'Browsable tester',
    asset_number: 'EQP-BROWSE',
    equipment_kind: 'measurement',
  });
  await create('complaint', 'receive_complaint', {
    title: 'Browsable complaint',
    summary: 'A record to browse.',
  });
  await create('observation', 'record_observation', {
    body: 'Every type should be browsable.',
    subjects: [product],
  });
  // ADR 0040: the overview is declared against the organization it describes.
  await create(
    'organization_overview',
    'declare_organization_overview',
    { title: 'What this organization is doing' },
    [fixtures.organizationId],
  );

  // The rest, by admin fixture (FIXTURE says where each act is proven).
  for (const [type, spec] of Object.entries(FIXTURE)) {
    made.set(
      type,
      await createObject(harness.adminPool, fixtures, {
        type,
        domain: spec.domain,
        state: spec.state,
        title: `Browsable ${type}`,
        createdBy: fixtures.reviewerId,
      }),
    );
  }

  // One current master record for the reader, compiled as an act, so every GET is a pure read.
  const compiled = await execute({
    actionType: 'compile_master_record',
    actorId: fixtures.reviewerId,
    actingRoleId: fixtures.reviewerRoleId,
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
    targetIds: [fixtures.reviewerId],
    idempotencyKey: `browse-compile-${randomUUID()}`,
    reason: 'compile the reader corpus for the every-type browse test',
  });
  expect(compiled.status).toBe('applied');
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function routeOptions(): DocumentRoutesOptions {
  return {
    pool: harness.pool,
    projections: loadProjectionDefinitions(ARTIFACT),
    identify: async () => ({
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    store: undefined,
    preflightInTransaction: async () => undefined,
    executeInTransaction: async () => {
      throw new Error('a GET of an Object View does not execute an action');
    },
  };
}

describe('every object type is browsable (KF-SAS-RQ-117)', () => {
  it('names, for every fixture-made type, where its create act is proven', () => {
    for (const [type, spec] of Object.entries(FIXTURE)) {
      expect(existsSync(join(ROOT, spec.proven)), `${type}: ${spec.proven}`).toBe(true);
    }
  });

  it('made one record of every type the registry declares', async () => {
    const declared = await withTransaction(harness.adminPool, async (tx) =>
      tx.query<{ id: string }>('select id from registry.object_type order by id'),
    );
    expect([...made.keys()].sort()).toEqual(declared.map((row) => row.id));
  });

  it('answers GET /objects/:id with an object_view Result for each', async () => {
    const app = Fastify({ logger: false });
    registerObjectViewRoute(app, routeOptions());
    await app.ready();
    try {
      const failures: string[] = [];
      for (const [type, id] of [...made.entries()].sort()) {
        const response = await app.inject({ method: 'GET', url: `/objects/${id}` });
        if (response.statusCode !== 200) {
          failures.push(`${type}: ${String(response.statusCode)} ${response.body}`);
          continue;
        }
        const { result } = response.json() as { result: ProjectionResult };
        const anchor = result.sections[0]?.members[0];
        if (
          result.definition.id !== 'object_view' ||
          anchor?.objectId !== id ||
          anchor.objectType !== type ||
          response.headers['x-kf-projection-digest'] !== result.projectionDigest
        ) {
          failures.push(`${type}: not an object_view anchored at ${id}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await app.close();
    }
    // Forty views, each evaluating the reader's permitted set and the projection.
  }, 300_000);
});
