import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type Tx } from '@kf/database';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * Which acts a principal may perform is decided by the database as well (20260924000100).
 *
 * The adversary is the application role writing the ledger row itself, having bound a REAL
 * principal — the one thing 20260923000200 still let it do. Every test runs as `kf_app` through
 * `harness.pool`. Refusals are paired with the same row for a principal who does hold the
 * authority, and with a non-institutional act by the principal who does not, so a trigger that
 * refused every row would fail here too.
 */
describe('an institutional act needs act authority in the database, not only in the dispatcher', () => {
  let h: Harness;
  let f: Fixtures;
  /** A person whose only role is scoped to one project: no act grant reaches anything else. */
  let narrow: { personId: string; roleId: string; projectId: string };
  let steward: { personId: string; roleId: string };
  let decision: string;

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    decision = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'Adopt the thing',
      createdBy: f.performerId,
    });
    const projectId = await createObject(h.adminPool, f, {
      type: 'initiative_project',
      domain: 'project',
      state: 'evaluating',
      title: 'A project somebody else runs',
      createdBy: f.reviewerId,
    });
    narrow = await withTransaction(h.adminPool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
        f.reviewerId,
        f.reviewerRoleId,
        f.clearanceActionId,
        'act-authority-fixture',
      ]);
      const envelope = (type: string, title: string) =>
        tx.one<{ id: string }>(
          `insert into core.object
             (object_type, authority_domain, lifecycle_state, classification, retention_class,
              schema_version, organization_id, title, created_by, updated_by)
           values ($1, 'organization', 'active', 'internal', 'project_record', $2, $3, $4, $5, $5)
           returning id`,
          [type, f.schemaVersion, f.organizationId, title, f.reviewerId],
        );
      const person = await envelope('person', 'Project-scoped approver');
      await tx.query(
        'insert into org.person (id, display_name, organization) values ($1, $2, $3)',
        [person.id, 'Project-scoped approver', f.organizationId],
      );
      const role = await envelope('role_assignment', 'technical_authority on one project');
      await tx.query(
        `insert into org.role_assignment (id, subject_id, role_id, scope_id)
         values ($1, $2, 'technical_authority', $3)`,
        [role.id, person.id, projectId],
      );
      await tx.query(
        `insert into org.person_clearance
           (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
         values ($1, $2, 'restricted', $3, $4, 'act-authority fixture clearance')`,
        [person.id, f.organizationId, f.reviewerId, f.clearanceActionId],
      );
      return { personId: person.id, roleId: role.id, projectId };
    });
    const declared = await runDeclareServiceActor(h.adminPool, {
      organizationId: f.organizationId,
      name: 'act-authority-steward',
      roleId: 'technical_authority',
      classification: 'restricted',
      declaredBy: f.reviewerId,
      reason: 'a service actor holding an organization-wide role, to prove the role is not enough',
    });
    steward = { personId: declared.personId, roleId: declared.roleAssignmentId };
  }, 240_000);

  afterAll(async () => {
    await h?.stop();
  });

  /**
   * Bind `actor` as the principal, name a fresh action in the sealed context, and write that
   * action's ledger row directly — the row the dispatcher would have written after its own
   * check, written without it.
   */
  const forge = (actor: string, role: string, actionType: string, targets: readonly string[]) =>
    withTransaction(h.pool, async (tx: Tx) => {
      const actionId = randomUUID();
      await tx.query('select core.bind_principal($1, $2, $3, $4)', [
        actor,
        role,
        f.organizationId,
        'restricted',
      ]);
      await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
        actor,
        role,
        actionId,
        'act-authority-test',
      ]);
      await tx.query(
        `insert into core.action
           (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
            target_ids, idempotency_key, effective_at, result_status)
         values ($1, $2, repeat('c', 64), $3, $4, $5, $6::uuid[], $7,
                 date_trunc('milliseconds', now()), 'applied')`,
        [
          actionId,
          f.organizationId,
          actionType,
          actor,
          role,
          targets,
          `forged-${actionId.slice(0, 12)}`,
        ],
      );
      return actionId;
    });

  it('refuses an institutional act by a principal no act grant reaches', async () => {
    await expect(
      forge(narrow.personId, narrow.roleId, 'accept_decision', [decision]),
    ).rejects.toThrow(/accept_decision requires act authority/);
  });

  it('still records a non-institutional act by that same principal', async () => {
    // create_initiative declares no `requires: act`; the role alone authorizes it. Without this
    // the refusal above could be a trigger that refuses everything this person writes.
    await expect(
      forge(narrow.personId, narrow.roleId, 'create_initiative', [narrow.projectId]),
    ).resolves.toBeTypeOf('string');
  });

  it('records the institutional act where the grant does reach', async () => {
    // Inside the project the person's scoped role covers, the act is theirs to perform.
    await expect(
      forge(narrow.personId, narrow.roleId, 'authorize_project', [narrow.projectId]),
    ).resolves.toBeTypeOf('string');
    // And the organization-scoped reviewer is covered everywhere.
    await expect(
      forge(f.reviewerId, f.reviewerRoleId, 'accept_decision', [decision]),
    ).resolves.toBeTypeOf('string');
  });

  it('refuses an institutional act by a service actor, whatever role it holds', async () => {
    await expect(
      forge(steward.personId, steward.roleId, 'accept_decision', [decision]),
    ).rejects.toThrow(/service actor cannot perform one/);
  });

  it('makes the same decision the dispatcher makes, through the same function', async () => {
    // Guard against a second implementation growing beside the first: the trigger must ask
    // `org.act_grant_reaches`, which is what `assertActCovered` asks.
    const body = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ src: string }>(
        `select prosrc as src from pg_proc
          where oid = 'core.action_requires_act_authority()'::regprocedure`,
      ),
    );
    expect(body.src).toContain(
      'org.act_grant_reaches(new.actor_id, new.organization_id, new.target_ids)',
    );
    expect(body.src).toContain('requires_capability');
  });
});
