/**
 * The database refuses an edge between object types its relation does not declare (SAS §100.2).
 *
 * `core.relation_endpoint_declared` (20260925030300) reads the seeded
 * `registry.relation_type_endpoint`. Planted here: an undeclared source, an undeclared target,
 * an update that re-types a legal edge into an illegal one, and — so the refusals mean something —
 * the declared pairs admitted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOntology } from '@kf/ontology-compiler';
import { join } from 'node:path';
import { withTransaction } from '@kf/database';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

let h: Harness;
let f: Fixtures;
const ids: Record<string, string> = {};

const make = (type: string, domain: string, state: string) =>
  createObject(h.adminPool, f, {
    type,
    domain,
    state,
    title: `${type} probe`,
    createdBy: f.performerId,
  });

const relate = (relation: string, source: string, target: string) =>
  withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    const row = await tx.one<{ id: string }>(
      `insert into core.relation (relation_type, source_id, target_id, created_by)
       values ($1, $2, $3, $4) returning id::text`,
      [relation, source, target, f.performerId],
    );
    return row.id;
  });

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  ids['payment'] = await make('payment', 'finance', 'planned');
  ids['invoice'] = await make('invoice', 'finance', 'draft');
  ids['decision'] = await make('decision_record', 'engineering', 'draft');
  ids['decision2'] = await make('decision_record', 'engineering', 'draft');
  ids['risk'] = await make('risk', 'qms', 'identified');
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('an edge connects only the types its relation declares', () => {
  it('seeds exactly the endpoints the ontology declares', async () => {
    const ontology = loadOntology(join(import.meta.dirname, '..', '..', 'ontology'));
    const declared = ontology.relationTypes.reduce(
      (n, r) => n + (r.sourceTypes?.length ?? 0) + (r.targetTypes?.length ?? 0),
      0,
    );
    const seeded = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from registry.relation_type_endpoint'),
    );
    expect(Number(seeded.n)).toBe(declared);
  });

  it('admits a declared pair', async () => {
    await expect(relate('settles', ids['payment']!, ids['invoice']!)).resolves.toMatch(/-/);
    await expect(relate('mitigates', ids['decision']!, ids['risk']!)).resolves.toMatch(/-/);
  });

  it('refuses an undeclared source type', async () => {
    await expect(relate('settles', ids['decision']!, ids['invoice']!)).rejects.toThrow(
      /settles may not start at a decision_record/,
    );
  });

  it('refuses an undeclared target type', async () => {
    await expect(relate('settles', ids['payment']!, ids['risk']!)).rejects.toThrow(
      /settles may not end at a risk/,
    );
  });

  it('refuses re-typing a legal edge into an illegal one', async () => {
    const edge = await relate('governs', ids['decision']!, ids['decision2']!);
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(`update core.relation set relation_type = 'bills' where id = $1`, [edge]);
      }),
    ).rejects.toThrow(/bills may not start at a decision_record/);
  });
});
