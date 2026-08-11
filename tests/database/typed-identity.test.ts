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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});

describe('verification does not over-claim', () => {
  /** A requirement with `count` approved test definitions against it. */
  async function subjectWithDefinitions(
    count: number,
  ): Promise<{ subject: string; definitions: string[] }> {
    const subject = await createObject(h.adminPool, f, {
      type: 'requirement',
      domain: 'engineering',
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
