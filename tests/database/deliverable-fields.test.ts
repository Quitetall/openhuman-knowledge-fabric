import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { loadOntology } from '@kf/ontology-compiler';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A deliverable holds the fields the ontology declares for it (ontology/README.md, migration
 * 20260925130100).
 *
 * The harness starts WITHOUT that migration, so a deliverable can be made the way the old table
 * held one; the migration is then applied over it, which is the only way to see that it keeps
 * what was there rather than that a fresh table is empty.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATION = '20260925130100_a_deliverable_has_its_ontology_fields.sql';

/** Ontology field → column. `artifact_refs` is carried by work.deliverable_submission rows. */
const COLUMN_OF: Readonly<Record<string, string | null>> = {
  work_package: 'work_package_id',
  work_order: 'work_order_id',
  description: 'description',
  acceptance_criteria: 'acceptance_criteria',
  due_date: 'due_date',
  artifact_refs: null,
};

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;
let packageId: string;
let otherPackageId: string;
let orderId: string;
let legacyId: string;

async function act(actionType: string, payload: Record<string, unknown>) {
  return execute({
    actionType,
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    targetIds: [],
    idempotencyKey: `deliverable-${actionType}-${randomUUID()}`,
    payload: payload as never,
  });
}

beforeAll(async () => {
  h = await startHarness({ skipMigrations: new Set([MIGRATION]) });
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(
    h.pool,
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    }),
  );

  const project = (
    await act('create_initiative', {
      title: 'Deliverable fields',
      objective: 'A deliverable holds its ontology fields.',
      sponsor_id: f.reviewerId,
    })
  ).objectIds[0]!;
  const makePackage = async (title: string): Promise<string> =>
    (
      await act('create_work_package', {
        title,
        project_id: project,
        scope_statement: 'Hand over a report.',
        acceptance_criterion: 'The report is accepted.',
      })
    ).objectIds.find((id) => id !== project)!;
  packageId = await makePackage('Covered package');
  otherPackageId = await makePackage('Uncovered package');

  // A deliverable as the old table held one, before the migration.
  legacyId = await createObject(h.adminPool, f, {
    type: 'deliverable',
    domain: 'project',
    state: 'planned',
    title: 'Legacy deliverable',
    createdBy: f.reviewerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      `insert into work.deliverable (id, work_package_id, deliverable_kind, definition_of_done)
       values ($1, $2, 'test_report', 'A signed test report for the enclosure.')`,
      [legacyId, packageId],
    );
  });

  const sql = readFileSync(join(ROOT, 'database', 'migrations', MIGRATION), 'utf8');
  const up = sql.slice(sql.indexOf('-- migrate:up'), sql.indexOf('-- migrate:down'));
  await withTransaction(h.adminPool, (tx) => tx.query(up));

  // A work order covering only the first package, by admin fixture: issuing one is a lifecycle
  // walk proven in the reference scenario, and what is under test here is the deliverable.
  const counterparty = await createObject(h.adminPool, f, {
    type: 'organization',
    domain: 'organization',
    state: 'active',
    title: 'Supplier Ltd',
    createdBy: f.reviewerId,
  });
  const engagement = await createObject(h.adminPool, f, {
    type: 'engagement',
    domain: 'commercial',
    state: 'draft',
    title: 'Supply engagement',
    createdBy: f.reviewerId,
  });
  orderId = await createObject(h.adminPool, f, {
    type: 'work_order',
    domain: 'commercial',
    state: 'draft',
    title: 'Work order',
    createdBy: f.reviewerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f, f.reviewerId);
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind)
       values ($1, $2, 'supplier')`,
      [counterparty, `Supplier Ltd (${counterparty})`],
    );
    await tx.query(
      `insert into org.engagement
         (id, principal_organization, counterparty, engagement_kind, starts_on)
       values ($1, $2, $3, 'supplier', '2026-09-01')`,
      [engagement, f.organizationId, counterparty],
    );
    await tx.query(
      `insert into work.work_order
         (id, project_id, engagement_id, order_number, scope_summary, ceiling_minor, currency)
       values ($1, $2, $3, $4, 'Report', 1000, 'GBP')`,
      [orderId, project, engagement, `WO-${randomUUID().slice(0, 8)}`],
    );
    await tx.query(
      'insert into work.work_order_scope (work_order_id, work_package_id) values ($1, $2)',
      [orderId, packageId],
    );
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe('work.deliverable and the ontology agree', () => {
  it('has a column for every declared field and no column the ontology does not declare', async () => {
    const deliverable = loadOntology(join(ROOT, 'ontology')).objectTypes.find(
      (type) => type.id === 'deliverable',
    )!;
    const declared = deliverable.fields.map((field) => field.name).sort();
    expect(declared).toEqual(Object.keys(COLUMN_OF).sort());
    const expected = Object.values(COLUMN_OF)
      .filter((column): column is string => column !== null)
      // The envelope: the record's identity, and its type as typed identity pins it.
      .concat('id', 'object_type')
      .sort();
    const columns = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'work' and table_name = 'deliverable'
          order by column_name`,
      ),
    );
    expect(columns.map((row) => row.column_name)).toEqual(expected);
  });

  it('kept what an existing deliverable held', async () => {
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ description: string; acceptance_criteria: string[]; kind: string; done: string }>(
        `select d.description, d.acceptance_criteria, r.deliverable_kind as kind,
                r.definition_of_done as done
           from work.deliverable d
           join work.deliverable_retired_attribute r on r.deliverable_id = d.id
          where d.id = $1`,
        [legacyId],
      ),
    );
    expect(row).toEqual({
      description: 'A signed test report for the enclosure.',
      acceptance_criteria: ['A signed test report for the enclosure.'],
      kind: 'test_report',
      done: 'A signed test report for the enclosure.',
    });
  });
});

describe('define_deliverable writes the ontology fields', () => {
  it('records description, criteria, due date and the covering order', async () => {
    const result = await act('define_deliverable', {
      title: 'Thermal test report',
      work_package_id: packageId,
      work_order_id: orderId,
      description: 'Thermal soak test of the enclosure at 60 °C.',
      acceptance_criteria: ['Soak held for 24 h', 'No deformation above 0.2 mm'],
      due_date: '2026-12-15',
    });
    expect(result.status, JSON.stringify(result)).toBe('applied');
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<Record<string, unknown>>(
        `select work_package_id, work_order_id, description, acceptance_criteria,
                due_date::text as due_date
           from work.deliverable where id = $1`,
        [result.objectIds[0]],
      ),
    );
    expect(row).toEqual({
      work_package_id: packageId,
      work_order_id: orderId,
      description: 'Thermal soak test of the enclosure at 60 °C.',
      acceptance_criteria: ['Soak held for 24 h', 'No deformation above 0.2 mm'],
      due_date: '2026-12-15',
    });
  });

  it('defaults the criteria to none and needs no order', async () => {
    const result = await act('define_deliverable', {
      title: 'Minimal deliverable',
      work_package_id: otherPackageId,
      description: 'Only what the ontology requires.',
    });
    expect(result.status, JSON.stringify(result)).toBe('applied');
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ acceptance_criteria: string[]; work_order_id: string | null }>(
        'select acceptance_criteria, work_order_id from work.deliverable where id = $1',
        [result.objectIds[0]],
      ),
    );
    expect(row).toEqual({ acceptance_criteria: [], work_order_id: null });
  });

  it('refuses an order that does not cover the package, and a blank criterion', async () => {
    await expect(
      act('define_deliverable', {
        title: 'Out of scope',
        work_package_id: otherPackageId,
        work_order_id: orderId,
        description: 'Named under an order that does not include its package.',
      }),
    ).rejects.toMatchObject({ failure: 'precondition_failed' });
    await expect(
      act('define_deliverable', {
        title: 'Blank criterion',
        work_package_id: packageId,
        description: 'A criterion nobody could check.',
        acceptance_criteria: ['   '],
      }),
    ).rejects.toThrow(/acceptance criterion/);
  });
});
