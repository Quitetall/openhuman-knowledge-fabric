/**
 * Rule implementation ledger.
 *
 * The ontology declares ten machine-enforceable invariants, and each names where it is
 * enforced. Declaring an enforcement point is not the same as having one. Without this
 * ledger, `registry.rule_definition` would list ten rules with `database_constraint` beside
 * them and a reader would reasonably conclude the database enforces ten things — when today
 * it enforces one.
 *
 * So the honest state is written down, asserted exhaustive, and checked against the
 * database. A rule added without a ledger entry fails. A rule whose entry claims LIVE is
 * verified by an actual planted violation below.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import {
  seedFixtures,
  startHarness,
  bindContext,
  createObject,
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

type Status = 'live' | 'pending';

interface LedgerEntry {
  readonly rule: string;
  readonly status: Status;
  /** For `pending`: the gate that delivers it, and what is missing. */
  readonly note: string;
}

/**
 * The ledger. EXHAUSTIVE — a rule in the ontology with no entry here fails the first test.
 *
 * One of ten is live. That is the true state of the system today, and stating it plainly is
 * the point: the financial invariants are the ones that stop a contractor being overpaid,
 * and none of them can be enforced until the tables they constrain exist.
 */
const LEDGER: readonly LedgerEntry[] = [
  {
    rule: 'KF-GRAPH-001',
    status: 'live',
    note: 'core.relation.source_id/target_id are foreign keys into core.object.',
  },
  {
    rule: 'KF-WORK-001',
    status: 'pending',
    note:
      'Gate 5. work.work_execution does not exist, so "exactly one work_order" has ' +
      'nothing to constrain.',
  },
  {
    rule: 'KF-WORK-002',
    status: 'pending',
    note:
      'Gate 5. work.work_order does not exist, so neither the project nor the engagement ' +
      'reference can be made NOT NULL and singular.',
  },
  {
    rule: 'KF-DEC-001',
    status: 'pending',
    note:
      'Gate 5. Supersession is modelled — the transition exists and the terminal-state ' +
      'trigger protects rejected/superseded/withdrawn — but nothing yet freezes the CONTENT ' +
      'of an accepted decision, which is the half of the rule that matters.',
  },
  {
    rule: 'KF-CHG-001',
    status: 'pending',
    note: 'Gate 5. engineering.change does not exist.',
  },
  {
    rule: 'KF-FIN-001',
    status: 'pending',
    note:
      'Gate 5. Accepted value vs authorized ceiling needs work.acceptance and ' +
      'work.work_order.',
  },
  {
    rule: 'KF-FIN-002',
    status: 'pending',
    note: 'Gate 5. Invoice line vs accepted value needs finance.invoice_line.',
  },
  {
    rule: 'KF-FIN-003',
    status: 'pending',
    note: 'Gate 5. Payment allocation bounds need finance.payment_allocation.',
  },
  {
    rule: 'KF-PROJ-001',
    status: 'pending',
    note: 'Gate 5. Progress is a computed projection over accepted or waived work packages.',
  },
  {
    rule: 'KF-PROJ-002',
    status: 'pending',
    note: 'Gate 5. Closure preconditions span work orders and financial obligations.',
  },
];

describe('the ledger is honest about coverage', () => {
  it('covers every rule the ontology declares, and no others', async () => {
    const rules = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ id: string }>('select id from registry.rule_definition order by id'),
    );
    expect(LEDGER.map((e) => e.rule).sort()).toEqual(rules.map((r) => r.id).sort());
  });

  it('reports one of ten enforced — say it plainly rather than imply ten', () => {
    const live = LEDGER.filter((e) => e.status === 'live');
    expect(live.map((e) => e.rule)).toEqual(['KF-GRAPH-001']);
    expect(LEDGER.filter((e) => e.status === 'pending')).toHaveLength(9);
  });

  it('makes every pending rule name the gate that delivers it', () => {
    for (const e of LEDGER.filter((x) => x.status === 'pending')) {
      expect(e.note, `${e.rule} must name its gate`).toMatch(/Gate \d/);
      expect(e.note.length, `${e.rule} needs a real explanation`).toBeGreaterThan(40);
    }
  });

  it('warns that the registry still ADVERTISES enforcement the database does not provide', async () => {
    // Not a failure — the ontology describes the target state, and the ledger above is the
    // record of the distance to it. Asserted so the distance cannot quietly grow.
    const claiming = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ id: string }>(
        `select id from registry.rule_definition
          where 'database_constraint' = any(implementation) order by id`,
      ),
    );
    const live = new Set(LEDGER.filter((e) => e.status === 'live').map((e) => e.rule));
    const advertisedButAbsent = claiming.map((r) => r.id).filter((id) => !live.has(id));
    expect(advertisedButAbsent).toEqual([
      'KF-FIN-001',
      'KF-FIN-002',
      'KF-FIN-003',
      'KF-WORK-001',
      'KF-WORK-002',
    ]);
  });
});

describe('KF-GRAPH-001 is genuinely enforced', () => {
  it('refuses an edge whose target is not a node', async () => {
    const source = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Anchor',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into core.relation (relation_type, source_id, target_id, created_by)
           values ('governs', $1, '01930000-0000-7000-8000-0000deadbeef', $2)`,
          [source, f.performerId],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('refuses an edge from a node to itself', async () => {
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Self',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into core.relation (relation_type, source_id, target_id, created_by)
           values ('governs', $1, $1, $2)`,
          [id, f.performerId],
        );
      }),
    ).rejects.toThrow(/relation_not_self/);
  });

  it('refuses the same active edge twice — it would double every count over it', async () => {
    const [a, b] = await Promise.all([
      createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: 'A',
        createdBy: f.performerId,
      }),
      createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: 'B',
        createdBy: f.performerId,
      }),
    ]);
    const insert = async (): Promise<void> =>
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into core.relation (relation_type, source_id, target_id, created_by)
           values ('governs', $1, $2, $3)`,
          [a, b, f.performerId],
        );
      });
    await insert();
    await expect(insert()).rejects.toThrow(/relation_unique_active/);
  });
});
