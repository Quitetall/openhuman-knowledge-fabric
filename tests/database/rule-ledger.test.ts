/**
 * Rule implementation ledger.
 *
 * The ontology declares machine-enforceable invariants, and each names where it is
 * enforced. Declaring an enforcement point is not the same as having one. Without this
 * ledger, `registry.rule_definition` could claim enforcement that no executable gate proves.
 *
 * So the honest state is written down, asserted exhaustive, and checked against the
 * database. A rule added without a ledger entry fails. A rule claiming LIVE cites the tests
 * that plant its violation — here, in the end-to-end scenario, or in its owning package's
 * database-backed suite — and each citation is checked to name a test that exists.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
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
  /** Where it is enforced, or — for `pending` — the gate that delivers it and what is missing. */
  readonly note: string;
  /**
   * For `live`: the tests that plant a violation and require the refusal, as
   * `path > test name`. Asserted to exist below, so a citation cannot outlive its test.
   */
  readonly evidence: readonly string[];
}

/**
 * The ledger. EXHAUSTIVE — a rule in the ontology with no entry here fails the first test.
 *
 * All sixteen are live, and each cites the test that watches it refuse. Until 2026-09-25 this
 * said six of fifteen, and that the work and finance tables did not exist: it had not been
 * revisited since Gate 5 landed them, and the financial rules had been enforced by database
 * triggers and action preconditions for weeks while this file called them pending.
 */
const LEDGER: readonly LedgerEntry[] = [
  {
    rule: 'KF-GRAPH-001',
    status: 'live',
    note: 'core.relation.source_id/target_id are foreign keys into core.object.',
    evidence: ['tests/database/rule-ledger.test.ts > refuses an edge whose target is not a node'],
  },
  {
    rule: 'KF-DOC-001',
    status: 'live',
    note:
      'content.document_source_holder enforces one current Holder, while document actions ' +
      'validate complete Holder identity and reserve changes for change_document_source_holder.',
    evidence: [
      'packages/documents/src/index.test.ts > materializes every narrow action without generic write, approval, or identifier authority',
    ],
  },
  {
    rule: 'KF-DOC-002',
    status: 'live',
    note:
      'Compilation persistence binds one exact active request action, finalized Basis, run ' +
      'and immutable compiled-view digests; database-backed document tests plant mismatches.',
    evidence: [
      'packages/documents/src/index.test.ts > materializes every narrow action without generic write, approval, or identifier authority',
    ],
  },
  {
    rule: 'KF-DOC-003',
    status: 'live',
    note:
      'Immutable content.document_policy is loaded from subject authority; action handlers ' +
      'reject caller downgrades and enforce technical plus policy-required quality authority.',
    evidence: [
      'packages/documents/src/index.test.ts > materializes every narrow action without generic write, approval, or identifier authority',
    ],
  },
  {
    rule: 'KF-DOC-004',
    status: 'live',
    note:
      'Proposal overlays are append-only and applied only through record/apply typed actions; ' +
      'applied fragments stay draft and official status requires separate controlled gates.',
    evidence: [
      'packages/documents/src/index.test.ts > materializes every narrow action without generic write, approval, or identifier authority',
    ],
  },
  {
    rule: 'KF-DOC-005',
    status: 'live',
    note:
      'content.document_publication is append-only and publication action locks and binds exact ' +
      'accepted run, effective controlled revision, view digest and active target policy.',
    evidence: [
      'packages/documents/src/index.test.ts > materializes every narrow action without generic write, approval, or identifier authority',
    ],
  },
  {
    rule: 'KF-WORK-001',
    status: 'live',
    note:
      'work.work_execution.work_order_id is NOT NULL and a single foreign key into ' +
      'work.work_order: an execution names exactly one order by construction.',
    evidence: [
      'tests/database/rule-ledger.test.ts > carries KF-WORK-001 and KF-WORK-002 as columns',
      'tests/database/rule-ledger.test.ts > refuses an execution, or an order, that names none',
    ],
  },
  {
    rule: 'KF-WORK-002',
    status: 'live',
    note:
      'work.work_order.project_id and engagement_id are each NOT NULL and a single foreign key, ' +
      'so an order names exactly one project and one engagement.',
    evidence: [
      'tests/database/rule-ledger.test.ts > carries KF-WORK-001 and KF-WORK-002 as columns',
      'tests/database/rule-ledger.test.ts > refuses an execution, or an order, that names none',
      'tests/end-to-end/reference-scenario.test.ts > issues a work order against exactly one project and one engagement',
    ],
  },
  {
    rule: 'KF-DEC-001',
    status: 'live',
    note:
      'The state machine gives accepted decisions one exit (supersede_decision) and rejected ' +
      'ones none, so every other act on them is an illegal transition. The KF-DEC-001 ' +
      'precondition registered on accept/reject/correct sits behind that check and is not ' +
      'reached; the body is content.adr_decision_body, which is append-only. The content half ' +
      "— a decided decision's title and its alternatives — is frozen by 20260925030000, which " +
      'raises KF-DEC-001 from the database.',
    evidence: [
      'tests/database/rule-ledger.test.ts > refuses every act on an accepted or rejected decision but supersession',
      "tests/database/rule-ledger.test.ts > refuses rewriting a decided decision's title or its alternatives",
    ],
  },
  {
    rule: 'KF-CHG-001',
    status: 'live',
    note:
      'approve_change and verify_change refuse a change record that implements no decision ' +
      '(work-control precondition).',
    evidence: [
      'tests/database/rule-ledger.test.ts > refuses to approve a change that cites no decision',
    ],
  },
  {
    rule: 'KF-FIN-001',
    status: 'live',
    note:
      'Database trigger on work.acceptance_record (raises KF-FIN-001) and the issue_acceptance ' +
      'precondition; the dispatcher surfaces either as precondition_failed naming the rule.',
    evidence: [
      'tests/end-to-end/reference-scenario.test.ts > KF-FIN-001: refuses acceptance beyond the authorized ceiling',
      'tests/database/rule-ledger.test.ts > enforces the financial rules in the database, not only in preconditions',
    ],
  },
  {
    rule: 'KF-FIN-002',
    status: 'live',
    note: 'Database trigger on finance.invoice_line (raises KF-FIN-002) against accepted value.',
    evidence: [
      'tests/end-to-end/reference-scenario.test.ts > KF-FIN-002: refuses an invoice line beyond the accepted value',
      'tests/database/rule-ledger.test.ts > enforces the financial rules in the database, not only in preconditions',
    ],
  },
  {
    rule: 'KF-FIN-003',
    status: 'live',
    note:
      'Database trigger on finance.payment_allocation (raises KF-FIN-003) and the ' +
      'authorize_payment precondition.',
    evidence: [
      'tests/end-to-end/reference-scenario.test.ts > KF-FIN-003: refuses a payment that overpays the invoice',
      'tests/database/rule-ledger.test.ts > enforces the financial rules in the database, not only in preconditions',
    ],
  },
  {
    rule: 'KF-PROJ-001',
    status: 'live',
    note:
      'Progress is a computed projection over accepted or waived work packages; no stored ' +
      'percentage exists to drift.',
    evidence: [
      'tests/end-to-end/reference-scenario.test.ts > KF-PROJ-001: progress comes from accepted work, not from spending',
    ],
  },
  {
    rule: 'KF-ENG-001',
    status: 'live',
    note:
      'close_engagement and terminate_engagement refuse while a non-terminal work order names ' +
      'the engagement (work-control precondition); the triggers ' +
      'work.assert_engagement_ends_after_its_orders and work.assert_order_under_live_engagement ' +
      'are the authority, under a lock on the engagement row.',
    evidence: [
      'tests/database/engagement-lifecycle.test.ts > KF-ENG-001: refuses to close or terminate an engagement while a work order under it is open',
      'tests/database/engagement-lifecycle.test.ts > KF-ENG-001: the database refuses the state change and a new order, whatever the caller',
    ],
  },
  {
    rule: 'KF-PROJ-002',
    status: 'live',
    note:
      'close_project_administrative refuses while any work order, invoice or work package is ' +
      'open (work-control precondition).',
    evidence: [
      'tests/end-to-end/reference-scenario.test.ts > KF-PROJ-002: refuses administrative closure while a work order is open',
    ],
  },
];

const ROOT = join(import.meta.dirname, '..', '..');

describe('the ledger is honest about coverage', () => {
  it('covers every rule the ontology declares, and no others', async () => {
    const rules = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ id: string }>('select id from registry.rule_definition order by id'),
    );
    expect(LEDGER.map((e) => e.rule).sort()).toEqual(rules.map((r) => r.id).sort());
  });

  it('reports sixteen of sixteen enforced, each with a cited test', () => {
    expect(LEDGER.filter((e) => e.status === 'pending').map((e) => e.rule)).toEqual([]);
    expect(LEDGER.filter((e) => e.status === 'live')).toHaveLength(16);
    for (const e of LEDGER.filter((x) => x.status === 'live')) {
      expect(
        e.evidence.length,
        `${e.rule} must cite the test that watches it refuse`,
      ).toBeGreaterThan(0);
    }
  });

  it('cites only tests that exist, by file and name', () => {
    for (const e of LEDGER) {
      for (const citation of e.evidence) {
        const [path, name] = citation.split(' > ') as [string, string];
        expect(name, `${e.rule}: ${citation}`).toBeDefined();
        const source = readFileSync(join(ROOT, path), 'utf8');
        expect(
          source.includes(`'${name}'`) ||
            source.includes(`"${name}"`) ||
            source.includes(`\`${name}\``),
          `${e.rule} cites "${name}", which ${path} does not define`,
        ).toBe(true);
      }
    }
  });

  it('makes every pending rule name the gate that delivers it', () => {
    for (const e of LEDGER.filter((x) => x.status === 'pending')) {
      expect(e.note, `${e.rule} must name its gate`).toMatch(/Gate \d/);
      expect(e.note.length, `${e.rule} needs a real explanation`).toBeGreaterThan(40);
    }
  });

  it('leaves no rule advertising database enforcement the ledger does not record as live', async () => {
    const claiming = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ id: string }>(
        `select id from registry.rule_definition
          where 'database_constraint' = any(implementation) order by id`,
      ),
    );
    const live = new Set(LEDGER.filter((e) => e.status === 'live').map((e) => e.rule));
    expect(claiming.map((r) => r.id).filter((id) => !live.has(id))).toEqual([]);
    // Not vacuous: six rules claim database enforcement.
    expect(claiming.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'KF-ENG-001',
        'KF-FIN-001',
        'KF-FIN-002',
        'KF-FIN-003',
        'KF-WORK-001',
        'KF-WORK-002',
      ]),
    );
  });
});

/**
 * What the frozen R01 reference validator implements, counted against its own source.
 *
 * Every rule claims `validator` in rules.yaml; SAS §100.1 says the shipped `validate_graph.py`
 * implements four of R01's ten. Three of the four are declared invariants — its fourth check,
 * invoice line totals, is a sum no rule names — and each is matched here to a message only that
 * check prints, so the count cannot claim a rule the validator does not refuse. The file is
 * frozen (tests/conformance/r01-golden); the gap is carried as a pack known gap.
 */
const VALIDATOR_IMPLEMENTS: Readonly<Record<string, string>> = {
  'KF-GRAPH-001': 'dangling edge',
  'KF-FIN-001': 'accepted value exceeds authorization',
  'KF-FIN-003': 'payment overallocated',
};

describe('the frozen R01 validator', () => {
  it('implements three declared rules, and the count is checked against its source', () => {
    const validator = readFileSync(
      join(ROOT, 'tests', 'conformance', 'r01-golden', 'validate_graph.py'),
      'utf8',
    );
    for (const [rule, message] of Object.entries(VALIDATOR_IMPLEMENTS)) {
      expect(
        LEDGER.map((e) => e.rule),
        `${rule} is not a ledger rule`,
      ).toContain(rule);
      expect(validator, `${rule} is not in the shipped validator`).toContain(message);
    }
    // The distance, stated rather than implied: the other thirteen rules (KF-ENG-001 claims no
    // validator) are discharged by the database and the dispatcher, not the distributed validator.
    expect(LEDGER.length - Object.keys(VALIDATOR_IMPLEMENTS).length).toBe(13);
  });
});

describe('rules the ledger records as enforced by the database', () => {
  it('carries KF-WORK-001 and KF-WORK-002 as columns', async () => {
    // NOT NULL plus one foreign key is "exactly one" by construction: there is no shape these
    // rows can take that names none, or two.
    const columns = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ col: string; nullable: string; target: string | null }>(
        `select c.table_name || '.' || c.column_name as col, c.is_nullable as nullable,
                (select k.confrelid::regclass::text from pg_constraint k
                  where k.conrelid = (c.table_schema || '.' || c.table_name)::regclass
                    and k.contype = 'f'
                    and k.conkey = array[(select a.attnum from pg_attribute a
                                           where a.attrelid = k.conrelid
                                             and a.attname = c.column_name)]) as target
           from information_schema.columns c
          where (c.table_schema, c.table_name, c.column_name) in
                (('work', 'work_execution', 'work_order_id'),
                 ('work', 'work_order', 'project_id'),
                 ('work', 'work_order', 'engagement_id'))
          order by 1`,
      ),
    );
    expect(columns).toEqual([
      { col: 'work_execution.work_order_id', nullable: 'NO', target: 'work.work_order' },
      { col: 'work_order.engagement_id', nullable: 'NO', target: 'org.engagement' },
      { col: 'work_order.project_id', nullable: 'NO', target: 'work.initiative_project' },
    ]);
  });

  it('refuses an execution, or an order, that names none', async () => {
    // The catalog check above says the columns are NOT NULL; this watches the refusal happen.
    const execution = await createObject(h.adminPool, f, {
      type: 'work_execution',
      domain: 'commercial',
      state: 'draft',
      title: 'Orphan execution',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into work.work_execution
             (id, work_order_id, performed_by, submitted_by, recorded_by, period_start,
              period_end, summary, claimed_value_minor, currency)
           values ($1, null, $2, $2, $2, current_date, current_date, 'x', 0, 'GBP')`,
          [execution, f.performerId],
        );
      }),
    ).rejects.toThrow(/null value in column "work_order_id"/);
    const order = await createObject(h.adminPool, f, {
      type: 'work_order',
      domain: 'commercial',
      state: 'draft',
      title: 'Orphan order',
      createdBy: f.performerId,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into work.work_order
             (id, project_id, engagement_id, order_number, scope_summary, ceiling_minor, currency)
           values ($1, null, null, 'WO-LEDGER-1', 'x', 0, 'GBP')`,
          [order],
        );
      }),
    ).rejects.toThrow(/null value in column "(project_id|engagement_id)"/);
  });

  it("refuses rewriting a decided decision's title or its alternatives", async () => {
    // KF-DEC-001's content half (20260925030000). A proposal is still being written, so the
    // same rewrite on it is admitted — the guard is on decided records, not on decisions.
    const decided = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'accepted',
      title: 'Use touchproof DIN',
      createdBy: f.performerId,
    });
    const proposal = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Draft wording',
      createdBy: f.performerId,
    });
    const rewrite = (id: string) =>
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `update core.object set title = 'Use a different connector',
                                  row_version = row_version + 1 where id = $1`,
          [id],
        );
      });
    await expect(rewrite(decided)).rejects.toThrow(/KF-DEC-001/);
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into engineering.decision_alternative (decision_id, summary, rejected_because)
           values ($1, 'An alternative nobody considered', 'Added after the fact')`,
          [decided],
        );
      }),
    ).rejects.toThrow(/KF-DEC-001/);
    await expect(rewrite(proposal)).resolves.toBeUndefined();
  });

  it('enforces the financial rules in the database, not only in preconditions', async () => {
    // Both layers guard KF-FIN-001..003 on purpose: under concurrency the trigger is the one that
    // wins. Each rule has an enabled row trigger whose function raises it, on the table the rule
    // is about. The end-to-end scenario watches each refuse.
    const triggers = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ rule: string; table: string }>(
        `select substring(p.prosrc from 'KF-FIN-00[0-9]') as rule, t.tgrelid::regclass::text as table
           from pg_trigger t join pg_proc p on p.oid = t.tgfoid
          where not t.tgisinternal and t.tgenabled <> 'D' and p.prosrc ~ 'KF-FIN-00[0-9]:'
          order by 1, 2`,
      ),
    );
    expect(triggers).toEqual(
      expect.arrayContaining([
        { rule: 'KF-FIN-001', table: 'work.acceptance_record' },
        { rule: 'KF-FIN-002', table: 'finance.invoice_line' },
        { rule: 'KF-FIN-003', table: 'finance.payment_allocation' },
      ]),
    );
  });
});

describe('rules enforced by the action path', () => {
  const dispatcher = () => createFabricDispatcher(h.pool);
  const act = (actionType: string, target: string, extra: Record<string, unknown> = {}) =>
    dispatcher()({
      actionType,
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [target],
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `ledger-${randomUUID()}`,
      reason: 'the rule ledger plants a violation',
      ...extra,
    });

  it('refuses every act on an accepted or rejected decision but supersession', async () => {
    for (const state of ['accepted', 'rejected']) {
      const decision = await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state,
        title: `An ${state} decision`,
        createdBy: f.performerId,
      });
      for (const actionType of ['accept_decision', 'reject_decision', 'correct_record']) {
        // The state machine refuses first; the KF-DEC-001 precondition behind it would refuse
        // too, if a transition out of a closed decision were ever declared.
        const refusal = await act(actionType, decision).catch((e: unknown) => e);
        expect(refusal, `${actionType} on ${state}`).toMatchObject({
          failure: expect.stringMatching(/^(?:illegal_transition|precondition_failed)$/),
        });
      }
    }
  });

  it('refuses to approve a change that cites no decision', async () => {
    const change = await createObject(h.adminPool, f, {
      type: 'change_record',
      domain: 'configuration',
      state: 'impact_assessment',
      title: 'A change with no rationale',
      createdBy: f.performerId,
    });
    await expect(
      act('approve_change', change, { payload: { to_state: 'approved' } }),
    ).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(/^KF-CHG-001:/),
    });
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
