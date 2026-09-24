/**
 * Rule implementation ledger.
 *
 * The ontology declares machine-enforceable invariants, and each names where it is
 * enforced. Declaring an enforcement point is not the same as having one. Without this
 * ledger, `registry.rule_definition` could claim enforcement that no executable gate proves.
 *
 * So the honest state is written down, asserted exhaustive, and checked against the
 * database. A rule added without a ledger entry fails. Every entry cites a test that plants a
 * violation — here, or in its owning package's database-backed suite — and the citation is
 * checked by title, so a renamed or deleted test fails the ledger (KF-SAS-RQ-078).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, createDispatcher, type ActionRequest } from '@kf/actions';
import { withTransaction } from '@kf/database';
import {
  WORK_CONTROL_EFFECTS,
  WORK_CONTROL_MATERIALIZERS,
  WORK_CONTROL_PRECONDITIONS,
} from '@kf/work-control';
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

type Status = 'live' | 'partial';

/** A test that plants a violation of the rule and asserts the refusal. */
interface Citation {
  /** Repository-relative path of the test file. */
  readonly file: string;
  /** The test's own title, exactly as written in `it('…')`. */
  readonly test: string;
}

interface LedgerEntry {
  readonly rule: string;
  /**
   * `live`: every claimed database or action enforcement exists and a cited test plants a
   * violation of it. `partial`: some of it does; `note` says which half is missing.
   */
  readonly status: Status;
  /** Where the database and the dispatcher enforce it. */
  readonly note: string;
  /** At least one planted-violation test. Each is checked to exist, by title, below. */
  readonly cited: readonly Citation[];
  /**
   * The shipped R01 reference validator (`tests/conformance/r01-golden/validate_graph.py`,
   * frozen): `implements` when it refuses a violation, `absent` when it does not. Every rule
   * claims `validator` in rules.yaml; SAS §100.1 records that the shipped one implements four
   * of R01's ten, and this column is where that is counted rather than asserted in prose.
   */
  readonly validator: 'implements' | 'absent';
}

const HERE = 'tests/database/rule-ledger.test.ts';
const SCENARIO = 'tests/end-to-end/reference-scenario.test.ts';
const DOCUMENTS = 'packages/documents/src/index.test.ts';

/**
 * The ledger. EXHAUSTIVE — a rule in the ontology with no entry here fails the first test.
 *
 * Until 2026-09-24 this said six of fifteen were live and nine "pending Gate 5" because the
 * work and finance tables did not exist. They had existed since 20260811001100/001200, with
 * triggers raising KF-FIN-001..003 and preconditions raising KF-DEC-001, KF-CHG-001 and
 * KF-PROJ-002 — the ledger had gone stale in the direction that understates, which is still a
 * false record. Every entry now cites the test that plants a violation, and the citations are
 * checked, so the ledger cannot drift from the tests again without a failure.
 */
const LEDGER: readonly LedgerEntry[] = [
  {
    rule: 'KF-GRAPH-001',
    status: 'live',
    note: 'core.relation.source_id/target_id are foreign keys into core.object.',
    cited: [{ file: HERE, test: 'refuses an edge whose target is not a node' }],
    validator: 'implements',
  },
  {
    rule: 'KF-WORK-001',
    status: 'live',
    note:
      'work.work_execution.work_order_id is one NOT NULL column with one foreign key into ' +
      'work.work_order; there is no shape of the row that names none or two.',
    cited: [{ file: HERE, test: 'refuses a work execution that names no work order' }],
    validator: 'absent',
  },
  {
    rule: 'KF-WORK-002',
    status: 'live',
    note: 'work.work_order.project_id and engagement_id are single NOT NULL foreign-key columns.',
    cited: [
      { file: HERE, test: 'refuses a work order that names no project or no engagement' },
      {
        file: SCENARIO,
        test: 'issues a work order against exactly one project and one engagement',
      },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-DEC-001',
    status: 'live',
    note:
      'The lifecycle half is the state machine: accepted exits only by supersede_decision and ' +
      'the other decided states are terminal. The content half is 20260925030000: a decided ' +
      "decision's title and its alternatives are frozen (KF-DEC-001 raised by the database). " +
      'The work-control precondition covers accept/reject/correct on a decided record.',
    cited: [
      {
        file: HERE,
        test: 'refuses every act that would move a decided decision, save supersession',
      },
      { file: HERE, test: "refuses rewriting a decided decision's title or its alternatives" },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-CHG-001',
    status: 'live',
    note:
      'approve_change and verify_change refuse a change that implements no decision ' +
      '(assertChangeCitesDecision); open_change cannot create one without a decision_id.',
    cited: [{ file: HERE, test: 'refuses approving a change that implements no decision' }],
    validator: 'absent',
  },
  {
    rule: 'KF-FIN-001',
    status: 'live',
    note:
      'finance trigger on work.acceptance_record against the ceiling plus approved amendments ' +
      '(20260811001200), and the issue_acceptance precondition before it.',
    cited: [
      { file: SCENARIO, test: 'KF-FIN-001: refuses acceptance beyond the authorized ceiling' },
    ],
    validator: 'implements',
  },
  {
    rule: 'KF-FIN-002',
    status: 'live',
    note: 'finance trigger on finance.invoice_line against the accepted value (20260811001200).',
    cited: [
      { file: SCENARIO, test: 'KF-FIN-002: refuses an invoice line beyond the accepted value' },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-FIN-003',
    status: 'live',
    note:
      'finance trigger on finance.payment_allocation (20260811001200) and the authorize_payment ' +
      'precondition.',
    cited: [{ file: SCENARIO, test: 'KF-FIN-003: refuses a payment that overpays the invoice' }],
    validator: 'implements',
  },
  {
    rule: 'KF-PROJ-001',
    status: 'live',
    note:
      'Progress is computed (@kf/work-control progress.ts) from accepted or waived packages; ' +
      'no stored percentage exists to disagree with it.',
    cited: [
      { file: SCENARIO, test: 'KF-PROJ-001: progress comes from accepted work, not from spending' },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-PROJ-002',
    status: 'live',
    note: 'close_project_administrative precondition (assertClosable).',
    cited: [
      {
        file: SCENARIO,
        test: 'KF-PROJ-002: refuses administrative closure while a work order is open',
      },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-DOC-001',
    status: 'live',
    note:
      'content.document_source_holder enforces one current Holder, while document actions ' +
      'validate complete Holder identity and reserve changes for change_document_source_holder.',
    cited: [
      {
        file: DOCUMENTS,
        test: 'materializes every narrow action without generic write, approval, or identifier authority',
      },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-DOC-002',
    status: 'live',
    note:
      'Compilation persistence binds one exact active request action, finalized Basis, run ' +
      'and immutable compiled-view digests; database-backed document tests plant mismatches.',
    cited: [
      {
        file: 'packages/documents/src/compiler.test.ts',
        test: 'rejects a compiler that silently omits one Basis source from HIR or CIR provenance',
      },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-DOC-003',
    status: 'live',
    note:
      'Immutable content.document_policy is loaded from subject authority; action handlers ' +
      'reject caller downgrades and enforce technical plus policy-required quality authority.',
    cited: [
      {
        file: DOCUMENTS,
        test: 'derives policy from the subject and rejects a caller downgrade assertion',
      },
      {
        file: DOCUMENTS,
        test: 'requires scoped quality authority in addition to technical authority for controlled policy',
      },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-DOC-004',
    status: 'live',
    note:
      'Proposal overlays are append-only and applied only through record/apply typed actions; ' +
      'applied fragments stay draft and official status requires separate controlled gates.',
    cited: [
      {
        file: DOCUMENTS,
        test: 'materializes every narrow action without generic write, approval, or identifier authority',
      },
    ],
    validator: 'absent',
  },
  {
    rule: 'KF-DOC-005',
    status: 'live',
    note:
      'content.document_publication is append-only and publication action locks and binds exact ' +
      'accepted run, effective controlled revision, view digest and active target policy.',
    cited: [
      {
        file: DOCUMENTS,
        test: 'materializes every narrow action without generic write, approval, or identifier authority',
      },
    ],
    validator: 'absent',
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

  it('cites, for every rule, a planted-violation test that exists under that title', () => {
    // A citation is a claim about another file. Checked here, so renaming or deleting the cited
    // test fails this one rather than leaving the ledger pointing at nothing.
    for (const entry of LEDGER) {
      expect(entry.cited.length, `${entry.rule} cites no test`).toBeGreaterThan(0);
      for (const citation of entry.cited) {
        const path = join(ROOT, citation.file);
        expect(existsSync(path), `${entry.rule}: ${citation.file} does not exist`).toBe(true);
        const source = readFileSync(path, 'utf8');
        const quoted = [`'${citation.test}'`, `"${citation.test}"`, `\`${citation.test}\``];
        expect(
          quoted.some((q) => source.includes(q)),
          `${entry.rule}: ${citation.file} has no test titled "${citation.test}"`,
        ).toBe(true);
      }
    }
  });

  it('reports every declared invariant enforced in the database or the dispatcher', () => {
    // Stated as a list so a regression names the rule rather than a count.
    expect(LEDGER.filter((e) => e.status !== 'live').map((e) => e.rule)).toEqual([]);
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
  });

  it('counts what the frozen R01 validator implements, against its own source', () => {
    // SAS §100.1: "The shipped validate_graph.py implements 4 of 10." Three of the four are
    // declared invariants (the fourth, invoice line totals, is a schema-level sum no rule
    // names). Each claim below is checked against a string only that check prints, so the
    // column cannot say `implements` for a rule the validator does not refuse.
    const validator = readFileSync(
      join(ROOT, 'tests', 'conformance', 'r01-golden', 'validate_graph.py'),
      'utf8',
    );
    const evidence: Readonly<Record<string, string>> = {
      'KF-GRAPH-001': 'dangling edge',
      'KF-FIN-001': 'accepted value exceeds authorization',
      'KF-FIN-003': 'payment overallocated',
    };
    const implemented = LEDGER.filter((e) => e.validator === 'implements').map((e) => e.rule);
    expect(implemented.sort()).toEqual(Object.keys(evidence).sort());
    for (const [rule, message] of Object.entries(evidence)) {
      expect(validator, `${rule} is not in the shipped validator`).toContain(message);
    }
    // The distance, stated rather than implied: every other rule's `validator` claim is
    // discharged by the database and the dispatcher, not by the distributed validator.
    expect(LEDGER.filter((e) => e.validator === 'absent')).toHaveLength(LEDGER.length - 3);
  });
});

describe('KF-WORK-001 and KF-WORK-002 are columns, not conventions', () => {
  it('refuses a work execution that names no work order', async () => {
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
    // And one column: there is no second place a second work order could be named.
    const refs = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ columns: string }>(
        `select array_to_string(array(select a.attname from unnest(c.conkey) k
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k), ',') as columns
           from pg_constraint c
          where c.conrelid = 'work.work_execution'::regclass and c.contype = 'f'
            and c.confrelid = 'work.work_order'::regclass`,
      ),
    );
    expect(refs.map((r) => r.columns)).toEqual(['work_order_id']);
  });

  it('refuses a work order that names no project or no engagement', async () => {
    const columns = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ attname: string; attnotnull: boolean }>(
        `select attname, attnotnull from pg_attribute
          where attrelid = 'work.work_order'::regclass and attname in ('project_id', 'engagement_id')
          order by attname`,
      ),
    );
    expect(columns).toEqual([
      { attname: 'engagement_id', attnotnull: true },
      { attname: 'project_id', attnotnull: true },
    ]);
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
});

describe('KF-DEC-001 and KF-CHG-001 are refused, not merely declared', () => {
  let execute: ReturnType<typeof createDispatcher>;
  let decision: string;
  let counter = 0;
  const act = (
    actionType: string,
    actor: 'performer' | 'reviewer',
    targetIds: readonly string[],
    payload: ActionRequest['payload'] = {},
  ) =>
    execute({
      organizationId: f.organizationId,
      actorId: actor === 'reviewer' ? f.reviewerId : f.performerId,
      actingRoleId: actor === 'reviewer' ? f.reviewerRoleId : f.performerRoleId,
      maxClassification: 'restricted',
      idempotencyKey: `ledger-${actionType}-${String((counter += 1))}`,
      actionType,
      targetIds: [...targetIds],
      payload,
      reason: 'planted violation for the rule ledger',
    });

  beforeAll(async () => {
    execute = createDispatcher(h.pool, {
      materializers: WORK_CONTROL_MATERIALIZERS,
      effects: WORK_CONTROL_EFFECTS,
      preconditions: WORK_CONTROL_PRECONDITIONS,
    });
    decision = (await act('propose_decision', 'performer', [], { title: 'Use touchproof DIN' }))
      .objectIds[0]!;
    await act('accept_decision', 'reviewer', [decision]);
  });

  it('refuses every act that would move a decided decision, save supersession', async () => {
    for (const actionType of ['accept_decision', 'reject_decision', 'correct_record']) {
      await expect(act(actionType, 'reviewer', [decision]), actionType).rejects.toBeInstanceOf(
        ActionRejected,
      );
    }
    const state = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ lifecycle_state: string }>('select lifecycle_state from core.object where id = $1', [
        decision,
      ]),
    );
    expect(state.lifecycle_state).toBe('accepted');
  });

  it("refuses rewriting a decided decision's title or its alternatives", async () => {
    const rewrite = (id: string) =>
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `update core.object set title = 'Use a different connector',
                                  row_version = row_version + 1 where id = $1`,
          [id],
        );
      });
    await expect(rewrite(decision)).rejects.toThrow(/KF-DEC-001/);
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f);
        await tx.query(
          `insert into engineering.decision_alternative (decision_id, summary, rejected_because)
           values ($1, 'An alternative nobody considered', 'Added after the fact')`,
          [decision],
        );
      }),
    ).rejects.toThrow(/KF-DEC-001/);
    // The guard is on DECIDED records only: a proposal is still being written.
    const proposal = (await act('propose_decision', 'performer', [], { title: 'Draft wording' }))
      .objectIds[0]!;
    await expect(rewrite(proposal)).resolves.toBeUndefined();
  });

  it('refuses approving a change that implements no decision', async () => {
    const change = await createObject(h.adminPool, f, {
      type: 'change_record',
      domain: 'configuration',
      state: 'impact_assessment',
      title: 'A change with no rationale',
      createdBy: f.performerId,
    });
    await expect(
      act('approve_change', 'reviewer', [change], { to_state: 'approved' }),
    ).rejects.toMatchObject({ detail: { rule: 'KF-CHG-001' } });
    // The same act on a change that cites its decision is not refused by KF-CHG-001.
    const cited = (
      await act('open_change', 'performer', [], { title: 'Cited change', decision_id: decision })
    ).objectIds[0]!;
    await expect(
      act('approve_change', 'reviewer', [cited], { to_state: 'approved' }),
    ).resolves.toMatchObject({ status: 'applied' });
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
