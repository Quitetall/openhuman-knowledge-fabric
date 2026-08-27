import type { ActionEffect, ObjectRow, PreconditionCheck } from '@kf/actions';
import { ActionRejected } from '@kf/actions';
import { assertDocumentAuthor } from './document-authority.js';
import { compileAndRecordMasterRecord } from '../master-record-repository.js';

export async function assertCompileMasterRecord(
  tx: Parameters<PreconditionCheck>[0],
  request: Parameters<PreconditionCheck>[1],
  objects: readonly ObjectRow[],
): Promise<void> {
  await assertDocumentAuthor(tx, request, objects);
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
