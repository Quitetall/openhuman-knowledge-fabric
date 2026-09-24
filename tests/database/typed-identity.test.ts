/**
 * Typed rows, and verification that does not over-claim.
 *
 * Two guarantees, both of which held only by convention until now.
 *
 * A typed row keyed on `core.object (id)` says the object exists; it does not say the object
 * is the KIND of thing the table is about. A supplier row could hang on a person, an invoice
 * on a work package, and every one would satisfy the foreign key while producing a record
 * that is two things at once. The composite (id, object_type) key makes that structural.
 *
 * And a verification report that says `verified` for one pass against twenty definitions is
 * the exact failure such a report exists to prevent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type Tx } from '@kf/database';
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

describe('a typed row is the type its table is about', () => {
  it('refuses a supplier row hung on a person', async () => {
    // The person exists, so the old single-column foreign key was perfectly satisfied.
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into quality.supplier (id, organization, criticality, scope_of_supply)
           values ($1, $2, 'standard', 'Nothing — this row should not exist.')`,
          [f.performerId, f.organizationId],
        );
      }),
    ).rejects.toThrow(/supplier_is_supplier|violates foreign key/);
  });

  it('refuses a work order hung on a decision record', async () => {
    const decision = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Not a work order',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into work.work_order
             (id, project_id, engagement_id, order_number, scope_summary, ceiling_minor, currency)
           values ($1, $1, $1, 'WO-BOGUS', 'x', 1, 'GBP')`,
          [decision],
        );
      }),
    ).rejects.toThrow(/violates foreign key/);
  });

  it('the type column cannot be written or changed — it is what the table IS', async () => {
    const item = await createObject(h.adminPool, f, {
      type: 'configuration_item',
      domain: 'configuration',
      state: 'proposed',
      title: 'Enclosure shell',
      createdBy: f.performerId,
    });
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into product.configuration_item
           (id, item_kind, part_number, revision_label, parent_system)
         values ($1, 'mechanical', 'ENC-100', 'A', $1)`,
        [item],
      );
    });

    // `generated always` — no INSERT may state it and no UPDATE may move it.
    await expect(
      withTransaction(h.adminPool, async (tx) =>
        tx.query("update product.configuration_item set object_type = 'supplier' where id = $1", [
          item,
        ]),
      ),
    ).rejects.toThrow(/can only be updated to DEFAULT/);
  });

  it('accepts the row when the object really is that type', async () => {
    const supplierObject = await createObject(h.adminPool, f, {
      type: 'supplier',
      domain: 'qms',
      state: 'prospective',
      title: 'Meridian Design Ltd',
      createdBy: f.performerId,
    });
    const written = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into quality.supplier (id, organization, criticality, scope_of_supply)
         values ($1, $2, 'significant', 'Mechanical design and prototyping.')`,
        [supplierObject, f.organizationId],
      );
      return tx.one<{ object_type: string }>(
        'select object_type from quality.supplier where id = $1',
        [supplierObject],
      );
    });
    expect(written.object_type).toBe('supplier');
  });

  it('binds every typed table to its type, by catalog, not by memory (RQ-030)', async () => {
    // A typed table is one whose single-column primary key references core.object (id): the
    // row IS that object. Each must also carry a constant object_type and the composite key
    // (id, object_type) → core.object (id, object_type). Two were keyed on the id alone until
    // 20260925030000 — work.warrant and ml.promotion_authority_decision — and nothing noticed,
    // because the earlier tests named their tables one by one.
    //
    // Keyed on an object of ANY type by design, so they have no single type to be:
    const ANY_TYPE: Record<string, string> = {
      'core.object_verification': 'a verification is of any record',
      'search.document': 'a derived index entry for any record',
    };
    const typed = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ tbl: string; bound: boolean; constant: string | null }>(
        `select format('%I.%I', n.nspname, c.relname) as tbl,
                exists (
                  select 1 from pg_constraint f2
                    join pg_attribute a on a.attrelid = f2.conrelid and a.attnum = f2.conkey[2]
                   where f2.conrelid = pk.conrelid and f2.contype = 'f'
                     and f2.confrelid = 'core.object'::regclass
                     and f2.conkey[1] = pk.conkey[1] and array_length(f2.conkey, 1) = 2
                     and a.attname = 'object_type' and a.attgenerated = 's'
                     and f2.confkey = array[
                       (select attnum from pg_attribute
                         where attrelid = 'core.object'::regclass and attname = 'id'),
                       (select attnum from pg_attribute
                         where attrelid = 'core.object'::regclass and attname = 'object_type')
                     ]::int2[]) as bound,
                (select pg_get_expr(d.adbin, d.adrelid)
                   from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = pk.conrelid and a.attname = 'object_type') as constant
           from pg_constraint pk
           join pg_class c on c.oid = pk.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where pk.contype = 'p' and array_length(pk.conkey, 1) = 1
            and exists (select 1 from pg_constraint f
                         where f.conrelid = pk.conrelid and f.contype = 'f'
                           and f.confrelid = 'core.object'::regclass and f.conkey = pk.conkey)
          order by 1`,
      ),
    );
    // A sweep that finds nothing proves nothing.
    expect(typed.length).toBeGreaterThan(25);
    const unbound = typed.filter((t) => !t.bound && !(t.tbl in ANY_TYPE)).map((t) => t.tbl);
    expect(unbound).toEqual([]);
    // Each constant names a registered object type.
    const types = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ id: string }>('select id from registry.object_type'),
    );
    const registered = new Set(types.map((t) => `'${t.id}'::text`));
    expect(
      typed.filter((t) => t.bound && !registered.has(t.constant ?? '')).map((t) => t.tbl),
    ).toEqual([]);
    expect(
      typed.filter((t) => t.tbl in ANY_TYPE).map((t) => t.tbl),
      'an any-type exemption names a table that is no longer keyed on core.object',
    ).toEqual(Object.keys(ANY_TYPE).sort());
  });

  it('refuses a warrant row hung on a decision record', async () => {
    const decision = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Not a warrant',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into work.warrant (id, warrant_uuid, repository, profile, assurance_level)
           values ($1, $1, 'Quitetall/LamQuant', 'delivery', 'basic')`,
          [decision],
        );
      }),
    ).rejects.toThrow(/warrant_is_warrant/);
  });
});

describe('a record’s authority domain is its type’s (RQ-001, RQ-010)', () => {
  const insertObject = (tx: Tx, type: string, domain: string, state: string) =>
    tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ($1, $2, $3, 'internal', 'project_record', $4, $5, 'Filed where it belongs?', $6, $6)
       returning id`,
      [type, domain, state, f.schemaVersion, f.organizationId, f.performerId],
    );

  it('refuses a CAPA filed under finance, from the application inside an act', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f);
        await insertObject(tx, 'capa', 'finance', 'open');
      }),
    ).rejects.toThrow(/object_authority_domain_is_the_types/);
  });

  it('refuses a domain that does not exist, even from the owner credential', async () => {
    // `quality` is not an authority domain; test fixtures used it for years.
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await insertObject(tx, 'controlled_document', 'quality', 'draft');
      }),
    ).rejects.toThrow(/object_authority_domain_is_the_types/);
  });

  it('refuses moving an existing record to another domain', async () => {
    const capa = await createObject(h.adminPool, f, {
      type: 'capa',
      domain: 'qms',
      state: 'open',
      title: 'Stays in the QMS',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `update core.object set authority_domain = 'project', row_version = row_version + 1
            where id = $1`,
          [capa],
        );
      }),
    ).rejects.toThrow(/object_authority_domain_is_the_types/);
  });

  it('accepts the domain the registry declares for the type', async () => {
    const row = await withTransaction(h.pool, async (tx) => {
      await bindContext(tx, f);
      return insertObject(tx, 'capa', 'qms', 'open');
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is validated over every existing row on a database that holds no mislabelled record', async () => {
    const key = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ validated: boolean }>(
        `select convalidated as validated from pg_constraint
          where conrelid = 'core.object'::regclass
            and conname = 'object_authority_domain_is_the_types'`,
      ),
    );
    expect(key.validated).toBe(true);
  });

  it('leaves the key unvalidated, and still binding, on a database the old code mislabelled', async () => {
    // The five materializers corrected with this migration filed records under `project` and
    // `engineering`. A host that ran them holds such rows; the migration must neither refuse
    // the deploy nor claim the key covers them.
    const MIGRATION = '20260925040000_the_authority_domain_is_the_types.sql';
    const old = await startHarness({ skipMigrations: new Set([MIGRATION]) });
    try {
      const of = await seedFixtures(old.adminPool);
      await createObject(old.adminPool, of, {
        type: 'work_order',
        domain: 'project',
        state: 'draft',
        title: 'Filed by the old materializer',
        createdBy: of.performerId,
      });
      const sql = readFileSync(
        join(import.meta.dirname, '..', '..', 'database', 'migrations', MIGRATION),
        'utf8',
      );
      const up = sql.slice(sql.indexOf('-- migrate:up'), sql.indexOf('-- migrate:down'));
      await withTransaction(old.adminPool, (tx) => tx.query(up));
      const key = await withTransaction(old.adminPool, (tx) =>
        tx.one<{ validated: boolean }>(
          `select convalidated as validated from pg_constraint
            where conrelid = 'core.object'::regclass
              and conname = 'object_authority_domain_is_the_types'`,
        ),
      );
      expect(key.validated).toBe(false);
      await expect(
        createObject(old.adminPool, of, {
          type: 'work_order',
          domain: 'project',
          state: 'draft',
          title: 'Filed by new code the same wrong way',
          createdBy: of.performerId,
        }),
      ).rejects.toThrow(/object_authority_domain_is_the_types/);
    } finally {
      await old.stop();
    }
  }, 240_000);

  it('holds an external locator’s authority to its four declared kinds', async () => {
    // content.external_locator.authority says what the outside copy IS to us — authoritative,
    // evidence, mirror or lookup — and is a CHECK, not a caller's free text.
    const allowed = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'content.external_locator'::regclass
            and conname = 'external_locator_authority_check'`,
      ),
    );
    for (const kind of ['authoritative', 'evidence', 'mirror', 'lookup']) {
      expect(allowed.def).toContain(`'${kind}'`);
    }
    await expect(
      withTransaction(h.adminPool, (tx) =>
        tx.query(
          `insert into content.external_locator (version_id, system, external_id, authority)
           values (gen_random_uuid(), 'drive', 'doc-1', 'owner')`,
        ),
      ),
    ).rejects.toThrow(/external_locator_authority_check/);
  });
});

describe('verification does not over-claim', () => {
  /** A requirement with `count` approved test definitions against it. */
  async function subjectWithDefinitions(
    count: number,
  ): Promise<{ subject: string; definitions: string[] }> {
    const subject = await createObject(h.adminPool, f, {
      type: 'requirement',
      domain: 'qms',
      state: 'approved',
      title: 'Leakage current below 10 µA',
      createdBy: f.performerId,
    });
    const definitions: string[] = [];
    for (let i = 0; i < count; i++) {
      const d = await createObject(h.adminPool, f, {
        type: 'test_definition',
        domain: 'engineering',
        state: 'approved',
        title: `Leakage test ${i}`,
        createdBy: f.performerId,
      });
      await withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into engineering.test_definition
             (id, method_kind, acceptance_criterion, verifies)
           values ($1, 'test', 'Below 10 µA at 250 Vac', $2)`,
          [d, subject],
        );
      });
      definitions.push(d);
    }
    return { subject, definitions };
  }

  async function execution(
    definition: string,
    state: string,
    executedOn: string | null,
  ): Promise<string> {
    const id = await createObject(h.adminPool, f, {
      type: 'test_execution',
      domain: 'engineering',
      state,
      title: 'Leakage run',
      createdBy: f.performerId,
    });
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into engineering.test_execution (id, test_definition, executed_on)
         values ($1, $2, $3)`,
        [id, definition, executedOn],
      );
    });
    return id;
  }

  async function link(subject: string, executionId: string): Promise<void> {
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into engineering.verification_link (subject_id, execution_id, created_by)
         values ($1, $2, $3)`,
        [subject, executionId, f.performerId],
      );
    });
  }

  async function status(subject: string) {
    return withTransaction(h.adminPool, async (tx) =>
      tx.one<{
        passed: string;
        failed: string;
        unexecuted: string;
        approved_definitions: string;
        definitions_passed: string;
        verified: boolean;
      }>('select * from engineering.verification_status where subject_id = $1', [subject]),
    );
  }

  it('is NOT verified on one pass against three definitions', async () => {
    // The headline over-claim. One pass out of twenty read exactly like twenty passes in the
    // first version of this view, which is the failure a verification report exists to catch.
    const { subject, definitions } = await subjectWithDefinitions(3);
    await link(subject, await execution(definitions[0]!, 'passed', '2026-08-01T10:00:00Z'));

    const s = await status(subject);
    expect(Number(s.approved_definitions)).toBe(3);
    expect(Number(s.definitions_passed)).toBe(1);
    expect(s.verified).toBe(false);
  });

  it('is verified once every approved definition has a passing run', async () => {
    const { subject, definitions } = await subjectWithDefinitions(2);
    for (const d of definitions) {
      await link(subject, await execution(d, 'passed', '2026-08-01T10:00:00Z'));
    }
    const s = await status(subject);
    expect(s.verified).toBe(true);
  });

  it('does NOT count a pass that never ran, and says so', async () => {
    // Nothing forces executed_on, so a row can reach `passed` with no execution behind it.
    // The old view counted it; this one reports it as unexecuted and refuses to verify.
    const { subject, definitions } = await subjectWithDefinitions(1);
    await link(subject, await execution(definitions[0]!, 'passed', null));

    const s = await status(subject);
    expect(Number(s.unexecuted)).toBe(1);
    expect(Number(s.passed)).toBe(0);
    expect(s.verified).toBe(false);
  });

  it('a single failure withdraws verification', async () => {
    const { subject, definitions } = await subjectWithDefinitions(1);
    await link(subject, await execution(definitions[0]!, 'passed', '2026-08-01T10:00:00Z'));
    expect((await status(subject)).verified).toBe(true);

    await link(subject, await execution(definitions[0]!, 'failed', '2026-08-02T10:00:00Z'));
    const s = await status(subject);
    expect(Number(s.failed)).toBe(1);
    expect(s.verified).toBe(false);
  });

  it('a subject with definitions and no runs at all is present and unverified', async () => {
    // Absent from the view would be indistinguishable from verified in any left join, which
    // is how "we never tested it" turns into "no problems found".
    const { subject } = await subjectWithDefinitions(2);
    const s = await status(subject);
    expect(Number(s.approved_definitions)).toBe(2);
    expect(Number(s.passed)).toBe(0);
    expect(s.verified).toBe(false);
  });
});

describe('records that must not close undecided', () => {
  it('refuses to close a complaint with no reportability decision', async () => {
    const id = await createObject(h.adminPool, f, {
      type: 'complaint',
      domain: 'qms',
      state: 'received',
      title: 'Device stopped recording mid-session',
      createdBy: f.performerId,
    });
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into quality.complaint (id, received_on, summary)
         values ($1, now(), 'Recording ended without warning.')`,
        [id],
      );
    });

    // A null reportability says even less than a bare false, and the rationale CHECK only
    // bound the case where somebody HAD decided.
    await expect(
      withTransaction(h.adminPool, async (tx) =>
        tx.query('update quality.complaint set closed_at = now() where id = $1', [id]),
      ),
    ).rejects.toThrow(/complaint_closed_needs_reportability/);
  });
});
