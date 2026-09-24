import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type Tx } from '@kf/database';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A clearance is organization-scoped and effective-dated (KF-SAS-RQ-038).
 *
 * Only a clearance that is live now, in the organization being bound, lets a person bind. Three
 * people below hold a live role assignment in the fixture organization and a clearance that is
 * wrong in exactly one way — it ended, it has not started, it is for another organization — and
 * each is refused at the bind, by the database, both for an administrator's bind and for the
 * attestor vouching that they are present. A fourth, identical but live, binds: without that
 * control, a refusal for any other reason would pass as this one.
 *
 * Tests only. What the effective ceiling is when an assignment carries its own ceiling is an
 * owner decision still pending, and nothing here asserts it.
 */

let h: Harness;
let f: Fixtures;
let otherOrganization: string;

interface Subject {
  readonly personId: string;
  readonly assignmentId: string;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  otherOrganization = randomUUID();
  await withTransaction(h.adminPool, async (tx) => {
    await fixtureContext(tx, otherOrganization);
    await tx.query(
      `insert into core.object
         (id, object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ($1, 'organization', 'organization', 'active', 'internal', 'project_record',
               $2, $1, 'Another company', $3, $3)`,
      [otherOrganization, f.schemaVersion, f.reviewerId],
    );
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind)
       values ($1, $2, 'company')`,
      [otherOrganization, `Another company (${otherOrganization})`],
    );
  });
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

async function fixtureContext(tx: Tx, organizationId: string): Promise<void> {
  await tx.query('select core.set_access_context($1, $2)', [organizationId, 'restricted']);
  await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
    f.reviewerId,
    f.reviewerRoleId,
    f.clearanceActionId,
    'clearance-validity-fixture',
  ]);
}

/** A person with a live assignment here, and one clearance as described. */
async function subject(
  name: string,
  clearance: { organizationId: string; from: string; to: string | null },
): Promise<Subject> {
  const make = (type: string, title: string) =>
    createObject(h.adminPool, f, {
      type,
      domain: 'organization',
      state: 'active',
      title,
      createdBy: f.reviewerId,
    });
  const personId = await make('person', name);
  const assignmentId = await make('role_assignment', `${name}'s performer assignment`);
  await withTransaction(h.adminPool, async (tx) => {
    await fixtureContext(tx, f.organizationId);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      personId,
      name,
      f.organizationId,
    ]);
    await tx.query(
      `insert into org.role_assignment (id, subject_id, role_id, scope_id)
       values ($1, $2, 'performer', $3)`,
      [assignmentId, personId, f.organizationId],
    );
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, valid_from, valid_to, granted_by,
          granted_by_action, reason)
       values ($1, $2, 'restricted', now() + $3::interval,
               now() + $4::interval, $5, $6, 'clearance validity fixture')`,
      [
        personId,
        clearance.organizationId,
        clearance.from,
        clearance.to,
        f.reviewerId,
        f.clearanceActionId,
      ],
    );
  });
  return { personId, assignmentId };
}

async function adminBind(s: Subject): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    const row = await tx.one<{ ceiling: string }>(
      'select core.bind_principal($1, $2, $3, $4) as ceiling',
      [s.personId, s.assignmentId, f.organizationId, 'internal'],
    );
    return row.ceiling;
  });
}

async function attested(s: Subject): Promise<string> {
  return h.attest({
    actorId: s.personId,
    actingRoleId: s.assignmentId,
    organizationId: f.organizationId,
    maxClassification: 'internal',
  });
}

describe('only a live clearance in this organization binds (KF-SAS-RQ-038)', () => {
  it('binds the control: a clearance that began an hour ago and has not ended', async () => {
    const live = await subject('Live clearance', {
      organizationId: f.organizationId,
      from: '-1 hour',
      to: null,
    });
    expect(await adminBind(live)).toBe('internal');
    expect(await attested(live)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['expired', { from: '-2 days', to: '-1 day' }],
    ['not yet in force', { from: '1 day', to: null }],
  ] as const)('refuses a clearance that is %s', async (label, window) => {
    const s = await subject(`Clearance ${label}`, { organizationId: f.organizationId, ...window });
    await expect(adminBind(s)).rejects.toThrow(/clearance is not granted/);
    await expect(attested(s)).rejects.toThrow(/clearance is not granted/);
  });

  it('refuses a clearance granted in another organization', async () => {
    const s = await subject('Cleared elsewhere', {
      organizationId: otherOrganization,
      from: '-1 hour',
      to: null,
    });
    await expect(adminBind(s)).rejects.toThrow(/clearance is not granted/);
    await expect(attested(s)).rejects.toThrow(/clearance is not granted/);
  });
});
