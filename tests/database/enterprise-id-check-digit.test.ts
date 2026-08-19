/**
 * The enterprise-identifier check digit, enforced in the database.
 *
 * OH-DOC-000001-3 R01 rule R7 says invalid check digits are "rejected at entry AND IMPORT".
 * Import is why this lives in PostgreSQL: a bulk load, a restore, a migration script or a psql
 * session reaches `core.object` without passing through any TypeScript, and a rule enforced
 * only in the application layer is not enforced on the path most likely to carry a typo.
 *
 * There are now three implementations of one table — `ontology-registry/damm.yaml` is
 * canonical, `damm.ts` is a checked copy, and `core.damm_check` is a translation into SQL.
 * The test below compares the SQL against the TypeScript across the ENTIRE six-digit space,
 * because a single transposed cell in a hundred-cell table produces a validator that accepts
 * some invalid identifiers and rejects some valid ones with no symptom until an identifier is
 * refused in the field. Sampling would very likely miss it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { dammCheck, formatEnterpriseId } from '@kf/ontology-compiler';
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

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('core.damm_check agrees with the TypeScript implementation', () => {
  it('over the entire six-digit sequence space', async () => {
    // One query over generate_series rather than 1,000,000 round trips. PostgreSQL computes
    // every check digit, TypeScript computes the same 1,000,000 locally, and the two are
    // compared row by row. Exhaustive over the whole sequence space, which is the point: a
    // sample would very likely step over a single transposed cell.
    //
    // Reporting stops after five mismatches. Five is enough to see the pattern, and a table
    // that is wrong is usually wrong for tens of thousands of inputs.
    const expected = new Array<number>(1_000_000);
    for (let n = 0; n < 1_000_000; n += 1) {
      expected[n] = dammCheck(String(n).padStart(6, '0'));
    }

    const rows = await h.adminPool.query<{ n: string; check: number }>(
      `select n::text as n, core.damm_check(lpad(n::text, 6, '0')) as check
         from generate_series(0, 999999) as n`,
    );
    expect(rows.rows).toHaveLength(1_000_000);

    const mismatches: string[] = [];
    for (const row of rows.rows) {
      const n = Number(row.n);
      if (row.check !== expected[n]) {
        mismatches.push(`${String(n).padStart(6, '0')}: sql ${row.check} vs ts ${expected[n]}`);
        if (mismatches.length >= 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('reproduces Appendix A for the record and serial payload widths', async () => {
    // The payload differs by kind and getting it wrong is the easy mistake: a record's digit
    // covers the year AND the sequence, ten digits, not the six-digit sequence alone.
    const { rows } = await h.adminPool.query<{ record: number; serial: number }>(
      `select core.damm_check('2026000001') as record, core.damm_check('000000001') as serial`,
    );
    expect(rows[0]).toEqual({ record: 5, serial: 3 });
  });

  it('raises on a non-digit rather than treating it as zero', async () => {
    await expect(h.adminPool.query(`select core.damm_check('00A001')`)).rejects.toThrow(
      /non-digit/,
    );
  });
});

describe('core.valid_enterprise_id', () => {
  const cases: [string, boolean, string][] = [
    ['OH-DOC-000001-3', true, 'this registry'],
    ['OH-DOC-000002-1', true, 'the Knowledge Fabric specification'],
    ['OH-ITM-000123-4', true, 'Appendix A worked example'],
    ['OH-RCD-2026-000001-5', true, 'record grammar, §9.4'],
    ['OH-SN-000000001-3', true, 'serial grammar, §10.1'],
    ['OH-DOC-000001-4', false, 'check digit wrong by one'],
    ['OH-DOC-000010-3', false, 'adjacent transposition'],
    ['OH-XYZ-000001-3', false, 'namespace nobody allocated'],
    ['OH-RCD-000001-3', false, 'RCD under the enterprise grammar'],
    ['OH-RCD-2026-000001-3', false, 'record digit computed over the sequence alone'],
    ['oh-doc-000001-3', false, 'lowercase'],
    ['OH-DOC-000001-3-R01', false, 'filename form, not an identifier'],
    ['OH-DOC-00001-3', false, 'five digits'],
  ];

  it.each(cases)('%s -> %s (%s)', async (id, valid) => {
    const { rows } = await h.adminPool.query<{ ok: boolean }>(
      'select core.valid_enterprise_id($1) as ok',
      [id],
    );
    expect(rows[0]?.ok).toBe(valid);
  });
});

describe('core.object refuses an invalid enterprise_id', () => {
  async function allocate(objectId: string, enterpriseId: string): Promise<void> {
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      // `row_version` advances by exactly 1 on every update — core.object carries optimistic
      // concurrency, and a test that bypassed it would be exercising a write path no real
      // caller uses.
      await tx.query(
        'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
        [objectId, enterpriseId],
      );
    });
  }

  async function newObject(title: string): Promise<string> {
    return createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title,
      createdBy: f.performerId,
    });
  }

  it('accepts null — an object has no enterprise identity until it is allocated (R9)', async () => {
    const id = await newObject('Unallocated by design');
    const { rows } = await h.adminPool.query<{ enterprise_id: string | null }>(
      'select enterprise_id from core.object where id = $1',
      [id],
    );
    expect(rows[0]?.enterprise_id).toBeNull();
  });

  it('rejects a wrong check digit BY NAME', async () => {
    // The falsification that matters. Before this constraint existed, OH-DOC-000001-4 — one
    // digit wrong on this organisation's own registry — was storable.
    const id = await newObject('Should not get a broken identifier');
    await expect(allocate(id, 'OH-DOC-000001-4')).rejects.toThrow(/object_enterprise_id_valid/);
  });

  it('rejects an unallocated namespace', async () => {
    const id = await newObject('Should not get an invented namespace');
    await expect(allocate(id, 'OH-XYZ-000001-3')).rejects.toThrow(/object_enterprise_id_valid/);
  });

  it('accepts a correctly formed identifier', async () => {
    const id = await newObject('Correctly allocated');
    const enterpriseId = formatEnterpriseId('ADR', 4242);
    await allocate(id, enterpriseId);
    const { rows } = await h.adminPool.query<{ enterprise_id: string }>(
      'select enterprise_id from core.object where id = $1',
      [id],
    );
    expect(rows[0]?.enterprise_id).toBe(enterpriseId);
  });
});

describe('an allocated enterprise_id is permanent (R8)', () => {
  it('refuses to change it, clear it, or move it to another object', async () => {
    const first = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Holds a permanent identifier',
      createdBy: f.performerId,
    });
    const allocated = formatEnterpriseId('ADR', 777);
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
        [first, allocated],
      );
    });

    const change = async (value: string | null): Promise<void> => {
      await withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
          [first, value],
        );
      });
    };

    // Changed to another VALID identifier. `unique` would not catch this: the identifier stops
    // naming what it named, and every external reference to it — a label, a purchase order, a
    // regulatory submission — silently resolves to something else.
    await expect(change(formatEnterpriseId('ADR', 778))).rejects.toThrow(/permanent/);
    // Cleared. Same harm, arriving as an absence.
    await expect(change(null)).rejects.toThrow(/permanent/);

    // Unchanged is not an error — an ordinary update that touches other columns must still work.
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        'update core.object set title = $2, row_version = row_version + 1 where id = $1',
        [first, 'Retitled, fine'],
      );
    });

    const { rows } = await h.adminPool.query<{ enterprise_id: string; title: string }>(
      'select enterprise_id, title from core.object where id = $1',
      [first],
    );
    expect(rows[0]).toEqual({ enterprise_id: allocated, title: 'Retitled, fine' });
  });

  it('still refuses a duplicate on another object', async () => {
    // `unique` predates this migration; asserted here so the trigger and the constraint are
    // known to coexist rather than one having quietly replaced the other.
    const a = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'First claimant',
      createdBy: f.performerId,
    });
    const b = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Second claimant',
      createdBy: f.performerId,
    });
    const contested = formatEnterpriseId('ADR', 999);

    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
        [a, contested],
      );
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
          [b, contested],
        );
      }),
    ).rejects.toThrow(/duplicate key|object_enterprise_id_key/);
  });
});
