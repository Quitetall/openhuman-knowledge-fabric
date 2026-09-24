/**
 * A person with a stated number of live assignments, for the capture tests (ADR 0034 §2).
 *
 * Whether the server may form the acting assignment turns on how many live assignments the
 * person holds, so the fixture takes that as its input rather than borrowing the seeded reviewer
 * or performer, whose assignment counts are an accident of the harness.
 */

import { withTransaction, type Pool } from '@kf/database';
import { createObject, type Fixtures } from './harness.js';

export interface EnrolledPerson {
  readonly personId: string;
  /** In the order given; each is live, restricted-cleared, in the fixture organization. */
  readonly assignmentIds: readonly string[];
}

export async function enrolPerson(
  adminPool: Pool,
  f: Fixtures,
  spec: {
    readonly name: string;
    /** Role and scope per assignment; scope defaults to the organization. */
    readonly assignments: readonly { readonly role: string; readonly scopeId?: string }[];
  },
): Promise<EnrolledPerson> {
  const personId = await createObject(adminPool, f, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: spec.name,
    createdBy: f.reviewerId,
  });
  const assignmentIds: string[] = [];
  for (const assignment of spec.assignments) {
    assignmentIds.push(
      await createObject(adminPool, f, {
        type: 'role_assignment',
        domain: 'organization',
        state: 'active',
        title: `${assignment.role} assignment of ${spec.name}`,
        createdBy: f.reviewerId,
      }),
    );
  }
  await withTransaction(adminPool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
    await tx.query('select core.set_transaction_context($1, $1, $2, $3)', [
      f.reviewerId,
      f.clearanceActionId,
      'people-fixture',
    ]);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      personId,
      spec.name,
      f.organizationId,
    ]);
    for (const [i, assignment] of spec.assignments.entries()) {
      await tx.query(
        `insert into org.role_assignment (id, subject_id, role_id, scope_id)
         values ($1, $2, $3, $4)`,
        [assignmentIds[i], personId, assignment.role, assignment.scopeId ?? f.organizationId],
      );
    }
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $2, 'restricted', $3, $4, 'people fixture clearance')`,
      [personId, f.organizationId, f.reviewerId, f.clearanceActionId],
    );
  });
  return { personId, assignmentIds };
}

/** A project to scope an assignment to, so its holder has no act over the organization. */
export async function fixtureProject(adminPool: Pool, f: Fixtures, title: string): Promise<string> {
  return createObject(adminPool, f, {
    type: 'initiative_project',
    domain: 'project',
    state: 'captured',
    title,
    createdBy: f.reviewerId,
  });
}
