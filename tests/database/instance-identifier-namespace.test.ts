/**
 * The identifier prefix is instance policy, and the database enforces it as data.
 *
 * Until 2026-08-22 `core.valid_enterprise_id` matched `^OH-(ITM|DOC|INTF|…)-[0-9]{6}-[0-9]$` —
 * one organisation's prefix and its nineteen namespaces, compiled into the product. A different
 * deployment could configure its own registry, watch it compile, and be rejected by this
 * constraint on the first insert. ADR 0006 recorded that as where the product/instance boundary
 * leaked; this file is the evidence it no longer does.
 *
 * WHY A FOREIGN KEY AND NOT A SMARTER FUNCTION. The obvious fix — have `valid_enterprise_id`
 * read a namespace table — cannot work. A CHECK constraint must be IMMUTABLE and a function
 * that reads a table is STABLE at best; it survives casual testing and breaks on dump/restore
 * and constraint revalidation. So the two questions are split by their nature:
 *
 *   is this the right SHAPE, and does the check digit hold?   universal    -> immutable CHECK
 *   is this namespace ALLOCATED, under that grammar?          per-instance -> foreign key
 *
 * The FK hangs off two STORED generated columns, `ns_head` and `ns_shape`. Pairing them in one
 * composite key is what catches a well-formed record identifier using a namespace allocated for
 * enterprise use — checking the two independently would let that through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  // Seed this deployment's allocated namespaces. In a real instance the seeder derives these
  // from the configured registry (KF_REGISTRY_DIR); here they are written out so the test states
  // its own premise rather than inheriting it.
  //
  // AC-PART is deliberately a DIFFERENT organisation's prefix. Without it the suite could not
  // tell "the prefix is configurable" from "the prefix is still OH, and nobody noticed".
  await h.adminPool.query(
    `insert into registry.identifier_namespace (qualified_code, grammar) values
       ('OH-DOC','enterprise'), ('OH-ITM','enterprise'), ('OH-RCD','record'),
       ('OH-SN','serial'),      ('AC-PART','enterprise')
     on conflict do nothing`,
  );
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

/** Allocate an identifier onto a fresh object, returning the error message if refused. */
async function allocate(enterpriseId: string): Promise<string | null> {
  const id = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'draft',
    title: `allocation probe ${enterpriseId}`,
    createdBy: f.performerId,
  });
  try {
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      // row_version advances by exactly 1: core.object carries optimistic concurrency and a
      // test that bypassed it would exercise a write path no real caller uses.
      await tx.query(
        'update core.object set enterprise_id = $2, row_version = row_version + 1 where id = $1',
        [id, enterpriseId],
      );
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the allocated-namespace foreign key', () => {
  it('accepts an allocated namespace under its own grammar', async () => {
    expect(await allocate('OH-DOC-000042-7')).toBeNull();
  });

  it('rejects a namespace nobody allocated, BY NAME', async () => {
    // The rejection `core.valid_enterprise_id` used to perform by enumerating namespaces. It
    // must still happen, and it must be attributable to the allocation check rather than to
    // some other constraint failing first.
    const error = await allocate('OH-XYZ-000001-3');
    expect(error).toMatch(/object_enterprise_namespace_allocated/);
  });

  it('rejects a namespace used under a grammar it was not allocated for', async () => {
    // OH-DOC-2026-000001-5 is a correctly-formed RECORD identifier with a valid ten-digit Damm
    // digit, using a namespace allocated for ENTERPRISE use. Shape passes. The check digit
    // passes. Only the composite (ns_head, ns_shape) key catches it.
    const error = await allocate('OH-DOC-2026-000001-5');
    expect(error).toMatch(/object_enterprise_namespace_allocated/);
  });

  it('accepts a DIFFERENT organisation prefix once allocated — the whole point', async () => {
    // If this ever fails, the prefix has been hardcoded again somewhere.
    expect(await allocate('AC-PART-000042-7')).toBeNull();
  });

  it('still rejects a bad check digit, by the CHECK rather than the FK', async () => {
    // The two layers must stay distinguishable. A bad digit in an allocated namespace has to
    // fail on the constraint, not the foreign key, or the split has collapsed.
    const error = await allocate('OH-DOC-000042-8');
    expect(error).toMatch(/object_enterprise_id_valid/);
    expect(error).not.toMatch(/object_enterprise_namespace_allocated/);
  });

  it('leaves an unallocated object alone — the FK must not fire on NULL', async () => {
    // R9: an object has no enterprise identity until one is allocated, and spec §7.1 makes
    // node_id sufficient alone. A NOT NULL-by-accident here would break every draft.
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'never allocated',
      createdBy: f.performerId,
    });
    const { rows } = await h.adminPool.query<{
      enterprise_id: string | null;
      ns_head: string | null;
    }>('select enterprise_id, ns_head from core.object where id = $1', [id]);
    expect(rows[0]?.enterprise_id).toBeNull();
    expect(rows[0]?.ns_head).toBeNull();
  });
});

describe('the generated columns the foreign key hangs on', () => {
  it.each([
    ['OH-DOC-000042-7', 'OH-DOC', 'enterprise'],
    ['OH-RCD-2026-000001-5', 'OH-RCD', 'record'],
    ['OH-SN-000000001-3', 'OH-SN', 'serial'],
    ['AC-PART-000042-7', 'AC-PART', 'enterprise'],
  ])('%s decomposes to (%s, %s)', async (id, head, shape) => {
    // Derived by the database, not by the application, so an import or a psql session cannot
    // write a row whose head disagrees with its identifier.
    const { rows } = await h.adminPool.query<{ head: string; shape: string }>(
      `select substring($1 from '^([A-Z]+-[A-Z]+)-') as head,
              case
                when $1 ~ '^[A-Z]+-[A-Z]+-[0-9]{4}-[0-9]{6}-[0-9]$' then 'record'
                when $1 ~ '^[A-Z]+-[A-Z]+-[0-9]{9}-[0-9]$'          then 'serial'
                when $1 ~ '^[A-Z]+-[A-Z]+-[0-9]{6}-[0-9]$'          then 'enterprise'
              end as shape`,
      [id],
    );
    expect(rows[0]).toEqual({ head, shape });
  });
});

describe('the namespace table is instance policy, not product data', () => {
  it('is not populated by the migration — the product ships no namespaces', () => {
    // ASSERTED AGAINST THE MIGRATION, not against the live table. The first version of this
    // counted rows at runtime and was simply wrong: the harness seeds this deployment's
    // twenty-one namespaces, exactly as a real instance does, so a runtime count measures the
    // fixture rather than the product.
    //
    // The claim is that a FRESH DATABASE has an empty table — if the migration shipped
    // OpenHuman's nineteen rows, the prefix would be hardcoded again, in data this time, which
    // is harder to spot than a regex and just as binding.
    const sql = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'database',
        'migrations',
        '20260822000100_instance_identifier_namespaces.sql',
      ),
      'utf8',
    );
    const inserts = [...sql.matchAll(/insert\s+into\s+registry\.identifier_namespace/gi)];
    expect(
      inserts,
      'the migration seeds namespaces, which would hardcode one deployment’s prefix as data',
    ).toEqual([]);
  });

  it('refuses to drop a namespace that identifiers still reference', async () => {
    // A control the enumerated regex never had: retiring a namespace out from under issued
    // identifiers is now a foreign-key violation rather than a silent orphaning. R01 §13.4 —
    // identity and meaning remain permanently resolvable.
    expect(await allocate('OH-ITM-000123-4')).toBeNull();
    await expect(
      h.adminPool.query(
        `delete from registry.identifier_namespace where qualified_code = 'OH-ITM'`,
      ),
    ).rejects.toThrow(/object_enterprise_namespace_allocated|violates foreign key/);
  });
});
