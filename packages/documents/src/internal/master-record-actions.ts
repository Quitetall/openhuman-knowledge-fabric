import type { ActionEffect, ObjectRow, PreconditionCheck } from '@kf/actions';
import { ActionRejected } from '@kf/actions';
import { assertDocumentAuthor } from './document-authority.js';
import { compileAndRecordMasterRecord } from '../master-record-repository.js';

export async function assertCompileMasterRecord(
  tx: Parameters<PreconditionCheck>[0],
  request: Parameters<PreconditionCheck>[1],
  objects: readonly ObjectRow[],
): Promise<void> {
  // A person's master record is theirs. Compiling YOUR OWN needs a live role assignment in
  // this organization and nothing more — a finance approver, an owner and a customer's
  // contact are exactly the people the record exists for, and the document-author rule
  // refused all three (found by the first fixture company, 2026-09-11). Compiling somebody
  // else's remains a document act under the author roles.
  const own = request.targetIds.length === 1 && request.targetIds[0] === request.actorId;
  if (own) {
    const assignment = await tx.maybeOne<{ id: string }>(
      `select id from org.role_assignment
        where id = $1 and subject_id = $2 and scope_id = $3
          and valid_from <= now() and (valid_to is null or valid_to > now())`,
      [request.actingRoleId, request.actorId, request.organizationId],
    );
    if (assignment === undefined) {
      throw new ActionRejected(
        'actor_not_authorized',
        'KF-DOC-AUTH-003: compiling your own master record requires a live role assignment ' +
          'in this organization, exercised as the acting role',
        { rule: 'KF-DOC-AUTH-003', actionType: request.actionType },
      );
    }
  } else {
    await assertDocumentAuthor(tx, request, objects);
  }
  if (
    request.targetIds.length !== 1 ||
    objects.length !== 1 ||
    objects[0]?.object_type !== 'person'
  ) {
    throw new ActionRejected(
      'precondition_failed',
      'compile_master_record targets exactly one visible person object',
    );
  }
  return tx
    .maybeOne<{ id: string }>(`select id from org.person where id = $1 and organization = $2`, [
      objects[0].id,
      request.organizationId,
    ])
    .then((person) => {
      if (person === undefined) {
        throw new ActionRejected(
          'precondition_failed',
          'master record person is not a member of the requested organization',
        );
      }
    });
}

export const compileMasterRecordEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const person = objects[0];
  if (person === undefined) throw new Error('compile_master_record person target disappeared');
  await compileAndRecordMasterRecord(tx, {
    personId: person.id,
    organizationId: request.organizationId,
    effectiveClassification: request.maxClassification as
      'public' | 'internal' | 'confidential' | 'restricted',
    recordedBy: request.actorId,
    recordedByAction: ctx.actionId,
    compiledAt: ctx.effectiveAt.toISOString(),
  });
};
