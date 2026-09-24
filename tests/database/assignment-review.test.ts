/**
 * ADR 0036: delegation goes one level deep, and a new assignment carries a review date.
 *
 * Every refusal here is the DATABASE's, made on the owner connection — the only connection that
 * writes role assignments (the application has no INSERT, 20260923000200) — so a rule that held
 * only for the application would hold for nobody. The one exception is the bootstrap identity on
 * the owner connection, and that is asserted too, so the exception cannot quietly widen.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type Tx } from '@kf/database';
import { assessReadiness } from '@kf/operations';
import { runBootstrap } from '../../apps/api/src/admin/bootstrap-organization.js';
import { planGrantAuthority, runGrantAuthority } from '../../apps/api/src/admin/grant-authority.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';
import { fixtureProject } from './people.js';

const BOOTSTRAP_IDENTITY = '01930000-0000-7000-8000-00000000b007';
const DAY_MS = 86_400_000;

let h: Harness;
let f: Fixtures;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
});

afterAll(async () => {
  await h?.stop();
});

/** Owner-connection context: the reviewer decides, as the admin commands' contexts do. */
async function asReviewer(tx: Tx): Promise<void> {
  await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
  await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
    f.reviewerId,
    f.reviewerRoleId,
    f.clearanceActionId,
    'assignment-review-test',
  ]);
}

async function person(name: string): Promise<string> {
  const id = await createObject(h.adminPool, f, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: name,
    createdBy: f.reviewerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await asReviewer(tx);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      id,
      name,
      f.organizationId,
    ]);
  });
  return id;
}

async function assignmentEnvelope(title: string, createdBy: string): Promise<string> {
  return createObject(h.adminPool, f, {
    type: 'role_assignment',
    domain: 'organization',
    state: 'active',
    title,
    createdBy,
  });
}

/** Insert one role assignment on the owner connection; `validTo` is SQL, so tests can say now(). */
async function assign(spec: {
  readonly subject: string;
  readonly role: string;
  readonly scope?: string;
  readonly validTo: string | null;
  readonly delegatedBy?: string;
  readonly bootstrap?: boolean;
}): Promise<string> {
  const id = await assignmentEnvelope(
    `${spec.role} assignment`,
    spec.bootstrap === true ? BOOTSTRAP_IDENTITY : f.reviewerId,
  );
  await withTransaction(h.adminPool, async (tx) => {
    if (spec.bootstrap === true) {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
        BOOTSTRAP_IDENTITY,
        f.clearanceActionId,
        'assignment-review-bootstrap',
      ]);
    } else {
      await asReviewer(tx);
    }
    await tx.query(
      `insert into org.role_assignment (id, subject_id, role_id, scope_id, delegated_by, valid_to)
       values ($1, $2, $3, $4, $5, ${spec.validTo ?? 'null'})`,
      [id, spec.subject, spec.role, spec.scope ?? f.organizationId, spec.delegatedBy ?? null],
    );
  });
  return id;
}

async function reviewDates(): Promise<{
  status: string | undefined;
  detail: string | undefined;
  measured: Readonly<Record<string, number | string | null>> | undefined;
}> {
  const report = await assessReadiness(h.adminPool);
  const check = report.institutional.checks.find((c) => c.id === 'assignment_review_dates');
  return { status: check?.status, detail: check?.detail, measured: check?.measured };
}

describe('every new role assignment ends within 366 days', () => {
  it('refuses one with no end, on the owner connection', async () => {
    const subject = await person('Open-ended Olive');
    await expect(assign({ subject, role: 'performer', validTo: null })).rejects.toThrow(
      /role assignment .* has no end date/,
    );
  });

  it('refuses one ending more than 366 days after it starts, and accepts 366 exactly', async () => {
    const subject = await person('Longtime Larry');
    await expect(
      assign({ subject, role: 'performer', validTo: "now() + interval '367 days'" }),
    ).rejects.toThrow(/ends more than 366 days after it starts/);
    const id = await assign({ subject, role: 'performer', validTo: "now() + interval '366 days'" });
    expect(id).toBeTruthy();
  });

  it('lets the bootstrap identity on the owner connection write one without an end, and nobody else', async () => {
    const subject = await person('Bootstrapped Bea');
    const id = await assign({ subject, role: 'reviewer', validTo: null, bootstrap: true });
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ valid_to: Date | null }>('select valid_to from org.role_assignment where id = $1', [
        id,
      ]),
    );
    expect(row.valid_to).toBeNull();
  });

  it('may bring an end forward, and may not remove it or move it later', async () => {
    const subject = await person('Shortened Sam');
    const id = await assign({ subject, role: 'performer', validTo: "now() + interval '200 days'" });
    const update = (sql: string) =>
      withTransaction(h.adminPool, async (tx) => {
        await asReviewer(tx);
        await tx.query(`update org.role_assignment set valid_to = ${sql} where id = $1`, [id]);
      });
    await expect(update("now() + interval '300 days'")).rejects.toThrow(/cannot be extended/);
    await expect(update('null')).rejects.toThrow(/cannot lose its end date/);
    await update("now() + interval '100 days'");
  });
});

describe('every new project membership ends within 366 days', () => {
  it('refuses one with no end or one too long, on the owner connection, and accepts one within a year', async () => {
    const project = await fixtureProject(h.adminPool, f, 'Membership review project');
    const member = await person('Member Mo');
    const insert = (validTo: string) =>
      withTransaction(h.adminPool, async (tx) => {
        await asReviewer(tx);
        await tx.query(
          `insert into org.project_membership (project_id, person_id, valid_to)
           values ($1, $2, ${validTo})`,
          [project, member],
        );
      });
    await expect(insert('null')).rejects.toThrow(/project membership .* has no end date/);
    await expect(insert("now() + interval '400 days'")).rejects.toThrow(
      /ends more than 366 days after it starts/,
    );
    await insert("now() + interval '200 days'");
  });
});

describe('delegation goes one level deep', () => {
  it('accepts a delegation from a direct holder and refuses the delegate delegating again', async () => {
    const holder = await person('Direct Dana');
    const delegate = await person('Delegate Dev');
    const second = await person('Second-hand Sid');
    const year = "now() + interval '1 year'";
    await assign({ subject: holder, role: 'performer', validTo: year });
    const delegated = await assign({
      subject: delegate,
      role: 'performer',
      validTo: year,
      delegatedBy: holder,
    });
    expect(delegated).toBeTruthy();
    await expect(
      assign({ subject: second, role: 'performer', validTo: year, delegatedBy: delegate }),
    ).rejects.toThrow(/delegated by a person who holds performer .* only through delegation/);

    // Nor by re-pointing an existing assignment at the delegate afterwards.
    const direct = await assign({
      subject: second,
      role: 'performer',
      validTo: year,
      delegatedBy: holder,
    });
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await asReviewer(tx);
        await tx.query('update org.role_assignment set delegated_by = $2 where id = $1', [
          direct,
          delegate,
        ]);
      }),
    ).rejects.toThrow(/only through delegation/);
  });

  it('refuses an access grant delegated from a grant that was itself delegated', async () => {
    const project = await fixtureProject(h.adminPool, f, 'Delegated grant project');
    const first = await person('Grant One');
    const second = await person('Grant Two');
    const third = await person('Grant Three');
    const grant = (principal: string, delegatedFrom: string | null) =>
      withTransaction(h.adminPool, async (tx) => {
        await asReviewer(tx);
        return (
          await tx.one<{ id: string }>(
            `insert into org.access_grant
               (organization_id, principal_kind, principal_id, capability, scope_object_id,
                granted_by, granted_by_action, delegated_from, reason)
             values ($1, 'person', $2, 'read', $3, $4, $5, $6, 'delegation depth test')
             returning id`,
            [
              f.organizationId,
              principal,
              project,
              f.reviewerId,
              f.clearanceActionId,
              delegatedFrom,
            ],
          )
        ).id;
      });
    const root = await grant(first, null);
    const once = await grant(second, root);
    await expect(grant(third, once)).rejects.toThrow(/which was itself delegated/);
  });
});

describe('kf:grant-authority ends what it grants, and renews by making a new assignment', () => {
  it('defaults the end to one year and takes --valid-to', () => {
    const now = new Date('2026-09-24T12:00:00.000Z');
    const base = {
      personId: randomUUID(),
      organizationId: randomUUID(),
      roleId: 'performer',
      classification: 'internal',
      grantedBy: randomUUID(),
      reason: 'assignment review test',
    };
    const defaulted = planGrantAuthority(base, now);
    expect(defaulted.ok && defaulted.grant.validTo.toISOString()).toBe('2027-09-24T12:00:00.000Z');
    expect(defaulted.ok && defaulted.grant.validToDefaulted).toBe(true);
    const stated = planGrantAuthority({ ...base, validTo: '2027-03-01' }, now);
    expect(stated.ok && stated.grant.validTo.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  it('writes the end it was given, keeps a re-run idempotent, and renews under --renew', async () => {
    const created = await runBootstrap(h.adminPool, {
      legalName: `Review Co (${randomUUID()})`,
      personName: 'Founder Fran',
      organizationKind: 'company',
      organizationId: '',
    });
    const grant = {
      personId: created.personId,
      organizationId: created.organizationId,
      roleId: 'project_owner',
      classification: 'restricted',
      grantedBy: created.personId,
      reason: 'founding grant, reviewed yearly',
      validTo: new Date(Date.now() + 100 * DAY_MS),
    };
    const first = await runGrantAuthority(h.adminPool, grant);
    expect(first.roleAssignmentValidTo?.toISOString()).toBe(grant.validTo.toISOString());

    const again = await runGrantAuthority(h.adminPool, grant);
    expect(again.changed).toBe(false);
    expect(again.roleAssignmentId).toBe(first.roleAssignmentId);

    const renewedTo = new Date(Date.now() + 300 * DAY_MS);
    const renewed = await runGrantAuthority(h.adminPool, {
      ...grant,
      reason: 'annual review: still the owner',
      validTo: renewedTo,
      renew: true,
    });
    expect(renewed.changed).toBe(true);
    expect(renewed.renewedAssignmentId).toBe(first.roleAssignmentId);
    expect(renewed.roleAssignmentId).not.toBe(first.roleAssignmentId);
    expect(renewed.roleAssignmentValidTo?.toISOString()).toBe(renewedTo.toISOString());

    await withTransaction(h.adminPool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        created.organizationId,
        'restricted',
      ]);
      const rows = await tx.query<{ id: string; live: boolean; ends_after_now: boolean }>(
        `select id, (valid_from <= now() and valid_to > now()) as live,
                valid_to > now() as ends_after_now
           from org.role_assignment where subject_id = $1 order by valid_from, id`,
        [created.personId],
      );
      expect(rows.filter((row) => row.live).map((row) => row.id)).toEqual([
        renewed.roleAssignmentId,
      ]);
      const action = await tx.one<{ parameters: { renews?: string; valid_to?: string } }>(
        'select parameters from core.action where id = $1',
        [renewed.actionId],
      );
      expect(action.parameters.renews).toBe(first.roleAssignmentId);
      expect(action.parameters.valid_to).toBe(renewedTo.toISOString());
    });
  });
});

describe('readiness reports grandfathered assignments as "no review date"', () => {
  it('degrades while one exists and clears when it is renewed', async () => {
    const before = await reviewDates();
    expect(before.status, before.detail).toBe('ok');
    const bootstrapBefore = Number(before.measured?.['bootstrap_assignments_no_review_date'] ?? 0);

    // A row from before ADR 0036: written as the migration found them, with no rule in force.
    const created = await runBootstrap(h.adminPool, {
      legalName: `Grandfathered Co (${randomUUID()})`,
      personName: 'Old Timer',
      organizationKind: 'company',
      organizationId: '',
    });
    const founded = await runGrantAuthority(h.adminPool, {
      personId: created.personId,
      organizationId: created.organizationId,
      roleId: 'performer',
      classification: 'internal',
      grantedBy: created.personId,
      reason: 'founding grant',
      validTo: new Date(Date.now() + 30 * DAY_MS),
    });
    // Three transactions: an ALTER cannot follow the update's pending constraint events.
    const trigger = (verb: 'disable' | 'enable') =>
      withTransaction(h.adminPool, (tx) =>
        tx.query(
          `alter table org.role_assignment ${verb} trigger role_assignment_has_a_review_date`,
        ),
      );
    await trigger('disable');
    try {
      await withTransaction(h.adminPool, (tx) =>
        tx.query('update org.role_assignment set valid_to = null where id = $1', [
          founded.roleAssignmentId,
        ]),
      );
    } finally {
      await trigger('enable');
    }

    const grandfathered = await reviewDates();
    expect(grandfathered.status).toBe('degraded');
    expect(grandfathered.detail).toContain('no review date');
    expect(grandfathered.measured?.['role_assignments_no_review_date']).toBe(1);

    // Run as the readiness login, not only the owner: the count must reach it too.
    const asApp = await assessReadiness(h.pool);
    expect(asApp.institutional.checks.find((c) => c.id === 'assignment_review_dates')?.status).toBe(
      'degraded',
    );

    // Re-running without --renew leaves it as it is — held, and still unreviewed.
    const held = await runGrantAuthority(h.adminPool, {
      personId: created.personId,
      organizationId: created.organizationId,
      roleId: 'performer',
      classification: 'internal',
      grantedBy: created.personId,
      reason: 'founding grant',
      validTo: new Date(Date.now() + 30 * DAY_MS),
    });
    expect(held.changed).toBe(false);
    expect(held.roleAssignmentValidTo).toBeNull();

    const renewed = await runGrantAuthority(h.adminPool, {
      personId: created.personId,
      organizationId: created.organizationId,
      roleId: 'performer',
      classification: 'internal',
      grantedBy: created.personId,
      reason: 'renewed at review',
      validTo: new Date(Date.now() + 365 * DAY_MS),
      renew: true,
    });
    expect(renewed.renewedAssignmentId).toBe(founded.roleAssignmentId);

    const after = await reviewDates();
    expect(after.status, after.detail).toBe('ok');
    expect(Number(after.measured?.['bootstrap_assignments_no_review_date'] ?? 0)).toBe(
      bootstrapBefore,
    );
  });
});
