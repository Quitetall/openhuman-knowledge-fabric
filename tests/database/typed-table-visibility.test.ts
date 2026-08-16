/**
 * Typed tables carry the substance; this proves they now carry the boundary too.
 *
 * `20260811000400_row_security.sql` protected `core.object` — the envelope: title, enterprise
 * id, organization, classification. The typed row holds what the record actually SAYS: a
 * nonconformity's description and containment, a controlled document's number and revision, a
 * person's record. Before `20260816000300_typed_table_row_security.sql` those tables had no
 * policies at all, so an unbound session saw zero objects and every typed row.
 *
 * The application path was protected in practice, because its queries join `core.object` and
 * inherit those policies through the join. That is a property of how the queries happen to be
 * written. This file asserts the property the DATABASE holds, which is the one that survives
 * somebody writing a query that does not join.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
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
let documentId: string;
let nonconformityId: string;

/** Stage-one tables that hold substance and are reachable in a seeded fixture set. */
const STAGE_ONE = [
  'quality.controlled_document',
  'quality.nonconformity',
  'org.person',
  'org.organization',
  'org.role_assignment',
] as const;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  documentId = await createObject(h.adminPool, f, {
    type: 'controlled_document',
    domain: 'quality',
    state: 'draft',
    title: 'Electrode cleaning procedure',
    createdBy: f.performerId,
  });
  nonconformityId = await createObject(h.adminPool, f, {
    type: 'nonconformity',
    domain: 'quality',
    state: 'open',
    title: 'Electrode impedance out of tolerance',
    createdBy: f.performerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `insert into quality.controlled_document
         (id, document_class, document_number, revision, owning_role)
       values ($1, 'procedure', 'OH-SOP-9001', 'R01', 'technical_authority')`,
      [documentId],
    );
    await tx.query(
      `insert into quality.nonconformity (id, severity, detected_on, description, subject_id)
       values ($1, 'major', now(), 'Impedance measured at 42 kOhm against a 5 kOhm limit', $2)`,
      [nonconformityId, documentId],
    );
  });
});

afterAll(async () => {
  await h?.stop();
});

describe('typed rows are visible exactly when their record is', () => {
  it('shows an unbound application session nothing at all', async () => {
    // kf_app_login inherits kf_app and is not the table owner — the shape a deployed API
    // process has. No access context is bound in this transaction, which is the state a
    // direct connection starts in.
    const counts = await withTransaction(h.pool, async (tx) => {
      const rows: Record<string, number> = {};
      for (const table of STAGE_ONE) {
        const row = await tx.one<{ n: string }>(`select count(*)::text as n from ${table}`);
        rows[table] = Number(row.n);
      }
      const objects = await tx.one<{ n: string }>('select count(*)::text as n from core.object');
      rows['core.object'] = Number(objects.n);
      return rows;
    });

    // Every entry, not just the interesting one: before this migration `core.object` read 0
    // and the typed tables read everything, which is exactly the asymmetry being closed.
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} must be invisible to an unbound session`).toBe(0);
    }
  });

  it('shows a bound session the substance of records it may see', async () => {
    const found = await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      return tx.one<{ document_number: string; description: string }>(
        `select document.document_number, finding.description
           from quality.controlled_document document
           join quality.nonconformity finding on finding.subject_id = document.id
          where document.id = $1`,
        [documentId],
      );
    });
    expect(found.document_number).toBe('OH-SOP-9001');
    expect(found.description).toMatch(/42 kOhm/);
  });

  it('hides the typed row when its envelope is above the reader clearance', async () => {
    // The predicate is `exists (… core.object …)` rather than a copy of the two axes, so the
    // classification ceiling reaches the typed row without being restated. Raising the
    // envelope's classification must therefore hide the substance, not just the title.
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      // row_version must advance by exactly one: the kernel's optimistic-concurrency guard
      // applies to a direct write the same as to any other.
      await tx.query(
        `update core.object
            set classification = 'restricted', row_version = row_version + 1
          where id = $1`,
        [nonconformityId],
      );
    });

    const atLowerClearance = await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'internal']);
      return tx.one<{ n: string }>(
        'select count(*)::text as n from quality.nonconformity where id = $1',
        [nonconformityId],
      );
    });
    expect(Number(atLowerClearance.n), 'restricted substance at internal clearance').toBe(0);

    const atFullClearance = await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      return tx.one<{ n: string }>(
        'select count(*)::text as n from quality.nonconformity where id = $1',
        [nonconformityId],
      );
    });
    expect(Number(atFullClearance.n), 'the same row at the clearance it needs').toBe(1);
  });

  it('leaves unprotected only the tables that were excluded on purpose', async () => {
    // Stage one took readable-without-policies from 77 to 47; stage two takes it to 19. The
    // remainder is not a backlog, it is a decision, so it is written down as an exact set:
    // anything joining or leaving this list has to be a deliberate edit to this test.
    //
    // The reasons, one per group, are in the migrations. In short: registry.* is vocabulary
    // that `core.object`'s own policies read to rank a row, so a policy there would be a
    // cycle; ops.* are deployment facts about the whole cluster, and asking which
    // organization owns a backup of everything has no answer; core.audit_checkpoint is the
    // global integrity spine; org.role and quality.federated_source carry no organization
    // anchor at all.
    const EXCLUDED_ON_PURPOSE = [
      'core.audit_checkpoint',
      'ops.backup_copy',
      'ops.backup_run',
      'ops.encrypted_backup_evidence',
      'ops.physical_failure_domain_evidence',
      'ops.recovery_objective',
      'ops.restore_drill',
      // kf_app still reads this one by design: sign-in resolves through it. The two roles
      // that had no business reading it lost the grant in 20260816000600, which is a
      // privilege rather than a policy, so the table stays on this list.
      'org.external_identity',
      'org.role',
      'quality.federated_source',
      'registry.action_type',
      'registry.classification',
      'registry.object_state',
      'registry.object_type',
      'registry.relation_type',
      'registry.retention_class',
      'registry.rule_definition',
      'registry.schema_release',
      'registry.state_machine',
      'registry.state_transition',
    ];

    const unprotected = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ table_name: string }>(
        `select namespace.nspname || '.' || class.relname as table_name
           from pg_class class
           join pg_namespace namespace on namespace.oid = class.relnamespace
          where class.relkind = 'r'
            and namespace.nspname not in ('pg_catalog', 'information_schema', 'public')
            and not class.relrowsecurity
            and (
              has_table_privilege('kf_readonly', class.oid, 'select')
              or has_table_privilege('kf_auditor', class.oid, 'select')
              or has_table_privilege('kf_app', class.oid, 'select')
            )
          order by 1`,
      ),
    );
    expect(unprotected.map((row) => row.table_name)).toEqual(EXCLUDED_ON_PURPOSE);
  });

  it('scopes the ledger, which is where substance lives before it reaches a typed row', async () => {
    // `core.action` carries `parameters` — the exact typed payload of every action ever
    // performed. A nonconformity's description is in `quality.nonconformity` because an
    // action put it there, and that action still holds it. Protecting the typed table while
    // leaving the action open would have been a boundary around the copy, not the original.
    const counts = await withTransaction(h.pool, async (tx) => {
      const rows: Record<string, number> = {};
      for (const table of ['core.action', 'core.approval', 'core.snapshot', 'core.outbox']) {
        const row = await tx.one<{ n: string }>(`select count(*)::text as n from ${table}`);
        rows[table] = Number(row.n);
      }
      return rows;
    });
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} must be invisible to an unbound session`).toBe(0);
    }

    // And a bound session still sees its own ledger. The action has to be REAL: the harness
    // binds a fixed bootstrap action id as transaction context without ever inserting the
    // row, so `core.action` is empty until something dispatches. Asserting "> 0" against that
    // fixture would have been asserting against nothing — it failed exactly that way first.
    const execute = createDispatcher(h.pool);
    const decision = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Use an independent internal frame',
      createdBy: f.performerId,
    });
    await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [decision],
      idempotencyKey: `visibility-${Date.now()}`,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });

    const bound = await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      return tx.one<{ n: string }>('select count(*)::text as n from core.action');
    });
    expect(Number(bound.n), 'a bound session must still see its own ledger').toBeGreaterThan(0);

    const stillHidden = await withTransaction(h.pool, async (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from core.action'),
    );
    expect(
      Number(stillHidden.n),
      'and the same action stays invisible without a context',
    ).toBe(0);
  });

  it('keeps the identity mapping off the direct-reader roles entirely', async () => {
    // `org.external_identity` cannot take a policy keyed on the caller's organization: it is
    // read BEFORE that claim has been verified, so scoping it turns "wrong organization" into
    // "unknown subject" and locks out anyone whose record sits above their requested
    // clearance. Protected by withdrawing the grant instead — which is why this asserts a
    // privilege rather than a row count.
    const grants = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{
        readonly_role: boolean;
        auditor: boolean;
        app: boolean;
        backup: boolean;
      }>(
        `select has_table_privilege('kf_readonly', 'org.external_identity', 'select') as readonly_role,
                has_table_privilege('kf_auditor', 'org.external_identity', 'select') as auditor,
                has_table_privilege('kf_app', 'org.external_identity', 'select') as app,
                has_table_privilege('kf_backup', 'org.external_identity', 'select') as backup`,
      ),
    );
    expect(grants.readonly_role, 'kf_readonly must not read the identity mapping').toBe(false);
    expect(grants.auditor, 'kf_auditor must not read the identity mapping').toBe(false);
    // And the two that must keep it: sign-in resolves through kf_app, and a backup missing
    // the identity links restores a fabric nobody can sign in to.
    expect(grants.app, 'kf_app resolves the caller at sign-in').toBe(true);
    expect(grants.backup, 'preservation exports the identity links').toBe(true);
  });

  it('resolves every view through the caller, not through the view owner', async () => {
    // A PostgreSQL view without `security_invoker` reads its underlying tables with the
    // OWNER's row-level security. Eleven of the twelve views here declare it; the twelfth,
    // `engineering.verification_status`, did not — and it aggregates three tables that
    // 20260816000300 had just placed under row-level security, and it is the view the
    // application queries to decide whether a risk control is verified.
    //
    // Asserted as a property of every view rather than of that one, because the next view
    // added is the one that will forget.
    const views = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ view: string }>(
        `select namespace.nspname || '.' || class.relname as view
           from pg_class class
           join pg_namespace namespace on namespace.oid = class.relnamespace
          where class.relkind = 'v'
            and namespace.nspname not in ('pg_catalog', 'information_schema')
            and not exists (
              select 1 from unnest(coalesce(class.reloptions, '{}')) option
               where option = 'security_invoker=true'
            )
          order by 1`,
      ),
    );
    expect(
      views.map((row) => row.view),
      'these views resolve their tables as the view owner, so what they show depends on how ' +
        'the database was provisioned rather than on who is asking',
    ).toEqual([]);
  });

  it('leaves the preservation role able to copy what it is granted', async () => {
    // kf_backup holds SELECT on every one of these tables and preservation is deliberately
    // cross-organization. Without its own policy the grant would survive while returning
    // nothing — a backup that looks complete and is not.
    const visible = await withTransaction(h.adminPool, async (tx) => {
      await tx.query('set local role kf_backup');
      return tx.one<{ documents: string; findings: string }>(
        `select (select count(*)::text from quality.controlled_document) as documents,
                (select count(*)::text from quality.nonconformity) as findings`,
      );
    });
    expect(Number(visible.documents)).toBeGreaterThan(0);
    expect(Number(visible.findings)).toBeGreaterThan(0);
  });
});
