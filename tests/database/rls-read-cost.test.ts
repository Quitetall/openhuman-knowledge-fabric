/**
 * What row-level security on the typed tables costs, measured on a populated database.
 *
 * `docs/decisions/0003-typed-table-row-security.md` shipped both RLS stages with the cost
 * question open, and said so twice: "the cost question still deserves a populated database"
 * and "a populated database would still be the right place to measure throughput". What was
 * known was the PLAN SHAPE at single-digit row counts, which predicts scaling but does not
 * measure it. This is the missing measurement.
 *
 * It is not a gate and does not run in CI — it populates ~100k rows and takes minutes. Run it
 * deliberately:
 *
 *     KF_MEASURE_RLS=1 npx vitest run tests/database/rls-read-cost.test.ts
 *
 * It lives in the test tree rather than in `scripts/` so that it is typechecked and linted
 * with everything else; a measurement harness that has rotted is worse than none, because it
 * gets run once in a crisis and believed.
 *
 * THREE POLICY SHAPES ARE MEASURED, because the 163 policies across the two stages are not
 * one thing:
 *
 *   1. envelope-keyed, the dominant shape (~90 policies)
 *      `exists (select 1 from core.object envelope where envelope.id = <t>.id)`
 *      — joins to a PRIMARY KEY, and `core.object.organization_id` is indexed.
 *   2. child chain, depth two
 *      `exists (select 1 from quality.controlled_document parent where parent.id = <t>.document_id)`
 *      — the parent is itself under a policy, so the predicate nests.
 *   3. direct column, `core.action` only
 *      `action.organization_id = core.current_organization()`
 *      — no join at all, which looks like the cheapest of the three and is the one this file
 *        was written to be suspicious of: `core.action.organization_id` carries NO INDEX,
 *        while `core.object.organization_id` and `search.document.organization_id` both do,
 *        and `core.action` is the append-only ledger that grows with every action performed.
 *
 * THE COMPARISON THAT MATTERS is not "RLS on versus no boundary at all" — that measures the
 * cost of being correct, which is not optional. It is "RLS on" versus the JOIN THROUGH
 * `core.object` that ADR 0003 says application queries already write, since that join is the
 * status quo the policy replaces. Both must return the same rows or the timings compare
 * different work, so the counts are asserted equal before any duration is reported.
 */

import { withTransaction, createPool, type Pool } from '@kf/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/** Off unless asked for: this populates ~100k rows and takes minutes. */
const MEASURING = process.env.KF_MEASURE_RLS === '1';

/** Objects per organization. Three organizations, so ~3x this in `core.object`. */
const DOCUMENTS_PER_ORG = 12_000;
/** Actions per organization. The ledger is the fastest-growing table, so it gets the most. */
const ACTIONS_PER_ORG = 12_000;
/** Timed repetitions per query. Median reported, so an outlier does not set the number. */
const RUNS = 7;

const BOOTSTRAP_ACTION = '01930000-0000-7000-8000-00000000ac10';

interface Measurement {
  readonly label: string;
  readonly rows: number;
  readonly medianMs: number;
  readonly minMs: number;
}

let harness: Harness | undefined;
let fixtures: Fixtures;
let readerPool: Pool;
let organizations: readonly string[] = [];

/** Median rather than mean: one scheduler hiccup should not become the reported cost. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Time one query, as the reader role, with the access context bound.
 *
 * The context is rebound inside every transaction because it is transaction-scoped — a
 * measurement that bound it once and then timed a later transaction would be timing the
 * unbound case, which sees nothing and is fast for the wrong reason.
 */
async function measure(label: string, sql: string, organizationId: string): Promise<Measurement> {
  const durations: number[] = [];
  let rows = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const elapsed = await withTransaction(readerPool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
      const startedAt = process.hrtime.bigint();
      const result = await tx.one<{ count: string }>(sql);
      const finishedAt = process.hrtime.bigint();
      rows = Number(result.count);
      return Number(finishedAt - startedAt) / 1e6;
    });
    durations.push(elapsed);
  }
  return { label, rows, medianMs: median(durations), minMs: Math.min(...durations) };
}

/** The plan PostgreSQL actually chose, which is what predicts behaviour at a larger size. */
async function planFor(sql: string, organizationId: string): Promise<string> {
  return withTransaction(readerPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
    const rows = await tx.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers) ${sql}`);
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  });
}

async function setRowSecurity(table: string, enabled: boolean): Promise<void> {
  await withTransaction(harness!.adminPool, async (tx) => {
    await tx.query(`alter table ${table} ${enabled ? 'enable' : 'disable'} row level security`);
  });
}

/** Create the extra organizations, then bulk-load documents, requirements and actions. */
async function populate(): Promise<void> {
  const admin = harness!.adminPool;

  const extraOrganizations = await withTransaction(admin, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [
      fixtures.organizationId,
      'restricted',
    ]);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      fixtures.performerId,
      BOOTSTRAP_ACTION,
      'rls-cost-populate',
    ]);
    const created: string[] = [];
    for (const name of ['Second Organization', 'Third Organization']) {
      const row = await tx.one<{ id: string }>(
        `insert into core.object
           (object_type, authority_domain, lifecycle_state, classification, retention_class,
            schema_version, organization_id, title, created_by, updated_by)
         values ('organization','organization','active','internal','project_record',
                 $1, $2, $3, $4, $4)
         returning id`,
        [fixtures.schemaVersion, fixtures.organizationId, name, fixtures.performerId],
      );
      // Re-home onto itself, as the harness does for the first organization: an organization
      // owned by another organization would skew every per-org count measured below.
      await tx.query(
        'update core.object set organization_id = $1, row_version = row_version + 1 where id = $1',
        [row.id],
      );
      await tx.query(
        `insert into org.organization (id, legal_name, organization_kind)
         values ($1, $2, 'company')`,
        [row.id, name],
      );
      created.push(row.id);
    }
    return created;
  });

  organizations = [fixtures.organizationId, ...extraOrganizations];

  const { roleId } = await withTransaction(admin, (tx) =>
    tx.one<{ roleId: string }>('select id as "roleId" from org.role order by id limit 1'),
  );
  const { actionType } = await withTransaction(admin, (tx) =>
    tx.one<{ actionType: string }>(
      'select id as "actionType" from registry.action_type order by id limit 1',
    ),
  );

  for (const organizationId of organizations) {
    await withTransaction(admin, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
      await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
        fixtures.performerId,
        BOOTSTRAP_ACTION,
        'rls-cost-populate',
      ]);

      // Envelopes first, tagged by title so the typed insert can find exactly these rows.
      await tx.query(
        `insert into core.object
           (object_type, authority_domain, lifecycle_state, classification, retention_class,
            schema_version, organization_id, title, created_by, updated_by)
         select 'controlled_document','quality','effective','internal','project_record',
                $1, $2, 'bench-doc-' || generated, $3, $3
           from generate_series(1, $4) as generated`,
        [fixtures.schemaVersion, organizationId, fixtures.performerId, DOCUMENTS_PER_ORG],
      );

      // Shape 1: envelope-keyed. `id` is both the primary key and the foreign key.
      await tx.query(
        `insert into quality.controlled_document
           (id, document_class, document_number, revision, owning_role)
         select envelope.id, 'procedure', 'BENCH-' || envelope.id, 'R1', $1
           from core.object envelope
          where envelope.organization_id = $2
            and envelope.title like 'bench-doc-%'
            and not exists (select 1 from quality.controlled_document existing
                             where existing.id = envelope.id)`,
        [roleId, organizationId],
      );

      // Shape 2: child chain. Primary key is (role_id, document_id), so one row per document.
      await tx.query(
        `insert into quality.training_requirement (role_id, document_id)
         select $1, document.id
           from quality.controlled_document document
           join core.object envelope on envelope.id = document.id
          where envelope.organization_id = $2
            and not exists (select 1 from quality.training_requirement existing
                             where existing.role_id = $1 and existing.document_id = document.id)`,
        [roleId, organizationId],
      );

      // Shape 3: direct column on the ledger. Each action targets one document in its own
      // organization, which is what `core.assert_action_semantic_scope` requires.
      await tx.query(
        `insert into core.action
           (action_type, actor_id, acting_role_id, target_ids, organization_id,
            idempotency_key, request_digest, effective_at, result_status)
         select $1, $2, $3, array[document.id], $4,
                'bench-' || document.id,
                md5(document.id::text) || md5(document.id::text || 'salt'),
                -- Millisecond precision. Audit digests serialize effective_at as RFC 3339
                -- milliseconds, and action_effective_at_canonical_wire refuses the
                -- microseconds now() returns rather than let two distinct instants collapse
                -- onto one signed preimage.
                date_trunc('milliseconds', now()), 'applied'
           from (select document.id
                   from quality.controlled_document document
                   join core.object envelope on envelope.id = document.id
                  where envelope.organization_id = $4
                  limit $5) as document`,
        [
          actionType,
          fixtures.performerId,
          fixtures.performerRoleId,
          organizationId,
          ACTIONS_PER_ORG,
        ],
      );
    });
  }

  // Without this the planner is working from empty-table statistics and every plan below is
  // an artefact of that, not of the data.
  await withTransaction(admin, async (tx) => {
    await tx.query('analyze core.object');
    await tx.query('analyze quality.controlled_document');
    await tx.query('analyze quality.training_requirement');
    await tx.query('analyze core.action');
  });
}

describe.skipIf(!MEASURING)('row-level security read cost on a populated database', () => {
  beforeAll(async () => {
    harness = await startHarness();
    fixtures = await seedFixtures(harness.adminPool);

    // A login role inheriting kf_readonly. ADR 0003 is about the DIRECT-CONNECTION path —
    // kf_readonly and kf_auditor connect and read without going through the application — so
    // measuring as kf_app would measure the path that was never the concern.
    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query(
        `do $$ begin
           if not exists (select from pg_roles where rolname = 'kf_readonly_login') then
             create role kf_readonly_login login password 'test-only-not-a-secret' inherit;
           end if;
         end $$`,
      );
      await tx.query('grant kf_readonly to kf_readonly_login');
      await tx.query('grant connect on database kf_test to kf_readonly_login');
    });
    const readerUri = new URL(harness.connectionString);
    readerUri.username = 'kf_readonly_login';
    readerUri.password = 'test-only-not-a-secret';
    readerPool = createPool({ connectionString: readerUri.toString(), maxConnections: 3 });

    await populate();
  }, 900_000);

  afterAll(async () => {
    await readerPool?.end().catch(() => undefined);
    await harness?.stop();
  }, 120_000);

  it('reports the cost of each policy shape against the join it replaces', async () => {
    const organizationId = organizations[0]!;
    const report: Measurement[] = [];

    // ── shape 1: envelope-keyed ──────────────────────────────────────────────────────────
    const envelopePolicy = await measure(
      'controlled_document · policy',
      'select count(*)::text as count from quality.controlled_document',
      organizationId,
    );
    await setRowSecurity('quality.controlled_document', false);
    const envelopeJoin = await measure(
      'controlled_document · join (status quo)',
      `select count(*)::text as count
         from quality.controlled_document document
         join core.object envelope on envelope.id = document.id`,
      organizationId,
    );
    const envelopeUnbounded = await measure(
      'controlled_document · no boundary (pre-ADR)',
      'select count(*)::text as count from quality.controlled_document',
      organizationId,
    );
    await setRowSecurity('quality.controlled_document', true);
    report.push(envelopePolicy, envelopeJoin, envelopeUnbounded);

    // ── shape 2: child chain ─────────────────────────────────────────────────────────────
    const childPolicy = await measure(
      'training_requirement · policy',
      'select count(*)::text as count from quality.training_requirement',
      organizationId,
    );
    await setRowSecurity('quality.training_requirement', false);
    const childJoin = await measure(
      'training_requirement · join (status quo)',
      `select count(*)::text as count
         from quality.training_requirement requirement
         join quality.controlled_document document on document.id = requirement.document_id`,
      organizationId,
    );
    await setRowSecurity('quality.training_requirement', true);
    report.push(childPolicy, childJoin);

    // ── shape 3: direct column, unindexed ────────────────────────────────────────────────
    const actionPolicy = await measure(
      'core.action · policy (organization_id, NO INDEX)',
      'select count(*)::text as count from core.action',
      organizationId,
    );
    await setRowSecurity('core.action', false);
    const actionExplicit = await measure(
      'core.action · explicit predicate, same column',
      `select count(*)::text as count from core.action
        where organization_id = core.current_organization()`,
      organizationId,
    );
    const actionUnbounded = await measure(
      'core.action · no boundary (pre-ADR)',
      'select count(*)::text as count from core.action',
      organizationId,
    );
    await setRowSecurity('core.action', true);
    report.push(actionPolicy, actionExplicit, actionUnbounded);

    const width = Math.max(...report.map((entry) => entry.label.length));
    const lines = report.map(
      (entry) =>
        `  ${entry.label.padEnd(width)}  ${entry.medianMs.toFixed(1).padStart(8)} ms median  ` +
        `${entry.minMs.toFixed(1).padStart(8)} ms min  ${String(entry.rows).padStart(7)} rows`,
    );
    const plans = [
      `controlled_document policy plan:\n${await planFor('select count(*) from quality.controlled_document', organizationId)}`,
      `core.action policy plan:\n${await planFor('select count(*) from core.action', organizationId)}`,
    ];
    // The report IS the deliverable here — this file exists to produce a number for a
    // decision record, not to assert one. `warn`/`error` would be lying about severity.
    // eslint-disable-next-line no-console
    console.info(
      [
        '',
        `Row-level security read cost — ${DOCUMENTS_PER_ORG} documents and ${ACTIONS_PER_ORG} actions per organization, ${organizations.length} organizations`,
        ...lines,
        '',
        ...plans,
      ].join('\n'),
    );

    // The comparison is only meaningful if both sides did the same work. A policy that
    // returned a different row count than the join it is being compared against would make
    // every duration above a comparison of two different questions.
    expect(
      envelopePolicy.rows,
      'the policy and the join it replaces must return the same rows, or the timings above ' +
        'compare different work and mean nothing',
    ).toBe(envelopeJoin.rows);
    expect(childPolicy.rows).toBe(childJoin.rows);
    expect(actionPolicy.rows).toBe(actionExplicit.rows);

    // Sanity: the boundary has to actually exclude the other organizations' rows, or these
    // are measurements of a policy that is not filtering.
    expect(envelopeUnbounded.rows).toBe(DOCUMENTS_PER_ORG * organizations.length);
    expect(envelopePolicy.rows).toBe(DOCUMENTS_PER_ORG);
    expect(actionUnbounded.rows).toBe(ACTIONS_PER_ORG * organizations.length);
    expect(actionPolicy.rows).toBe(ACTIONS_PER_ORG);
  }, 900_000);

  it('attributes the envelope-keyed cost to a specific term in the core.object predicate', async () => {
    // The first test says envelope-keyed reads cost ~50x what the `core.action` column
    // predicate costs. That is a number, not a cause, and a number without a cause gets
    // "optimised" by guessing. `core.object`'s own policy is
    //
    //   (organization_id = current AND (select rank ...) <= current_rank)
    //   OR content.document_basis_classifier_active()
    //   OR content.compiler_runtime_active()
    //
    // Three candidate costs: the correlated rank lookup, and the two zero-argument function
    // calls. All three are declared STABLE, which is often misread as "evaluated once" — it
    // is not. STABLE promises the same answer within a statement, which lets the planner use
    // the value in an index condition; in a per-row FILTER it still calls the function per
    // row. So the OR branches may run once per scanned row, and the rows that fail the first
    // branch — the other organizations' — are exactly the ones that reach them.
    //
    // Measured by evaluating each term standalone against the same rows, with RLS off so the
    // policy is not also running underneath and being counted twice.
    const organizationId = organizations[0]!;
    await setRowSecurity('core.object', false);
    try {
      const scanOnly = await measure(
        'core.object · scan, no predicate',
        'select count(*)::text as count from core.object',
        organizationId,
      );
      const organizationOnly = await measure(
        'core.object · organization term only',
        `select count(*)::text as count from core.object
          where organization_id = core.current_organization()`,
        organizationId,
      );
      const withRank = await measure(
        'core.object · organization + classification rank',
        `select count(*)::text as count from core.object envelope
          where envelope.organization_id = core.current_organization()
            and (select rank from registry.classification
                  where id = envelope.classification) <= core.current_classification_rank()`,
        organizationId,
      );
      const withOrBranches = await measure(
        'core.object · full policy predicate, hand-written',
        `select count(*)::text as count from core.object envelope
          where (envelope.organization_id = core.current_organization()
                 and (select rank from registry.classification
                       where id = envelope.classification) <= core.current_classification_rank())
             or content.document_basis_classifier_active()
             or content.compiler_runtime_active()`,
        organizationId,
      );

      // The candidate fix, measured rather than asserted. Both OR branches are row-
      // INDEPENDENT — they ask whether a runtime is active, not anything about the row — so
      // wrapping each in an uncorrelated scalar subquery lets the planner lift it into an
      // InitPlan evaluated once per statement instead of once per row. Same truth value,
      // same rows; the only thing that changes is how many times it is computed.
      const withHoistedOrBranches = await measure(
        'core.object · same predicate, OR branches hoisted',
        `select count(*)::text as count from core.object envelope
          where (envelope.organization_id = core.current_organization()
                 and (select rank from registry.classification
                       where id = envelope.classification) <= core.current_classification_rank())
             or (select content.document_basis_classifier_active())
             or (select content.compiler_runtime_active())`,
        organizationId,
      );

      const terms = [scanOnly, organizationOnly, withRank, withOrBranches, withHoistedOrBranches];
      const width = Math.max(...terms.map((entry) => entry.label.length));
      // eslint-disable-next-line no-console
      console.info(
        [
          '',
          'Where the envelope-keyed cost goes — each term added to the one above it',
          ...terms.map(
            (entry) =>
              `  ${entry.label.padEnd(width)}  ${entry.medianMs.toFixed(1).padStart(8)} ms median  ` +
              `${String(entry.rows).padStart(7)} rows`,
          ),
          '',
          `  rank term costs        ${(withRank.medianMs - organizationOnly.medianMs).toFixed(1)} ms`,
          `  OR branches cost       ${(withOrBranches.medianMs - withRank.medianMs).toFixed(1)} ms`,
          `  hoisting recovers      ${(withOrBranches.medianMs - withHoistedOrBranches.medianMs).toFixed(1)} ms`,
          '',
        ].join('\n'),
      );

      // A faster query that returns different rows is not a fix, it is a bug. The hoisted
      // form has to agree with the form it replaces before its timing means anything.
      expect(
        withHoistedOrBranches.rows,
        'hoisting the OR branches changed which rows come back, so it is not the same predicate',
      ).toBe(withOrBranches.rows);

      // The hand-written predicate must select what the policy selects, or it is not the
      // predicate under study and the attribution above is of something else.
      expect(
        withOrBranches.rows,
        'the hand-written predicate does not match what the policy returns, so it is not the ' +
          'policy being attributed',
      ).toBe(DOCUMENTS_PER_ORG + 1 + 2 + 2); // documents + organization + 2 people + 2 roles
    } finally {
      await setRowSecurity('core.object', true);
    }
  }, 900_000);
});
