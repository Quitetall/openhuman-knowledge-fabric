import type { ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';
import { requireString } from '@kf/record-atoms';
import {
  createCompilationBasis,
  type CompilationBasis,
  type CompilationBasisInput,
} from '../compiler.js';
import { refuseDocument, requireRecord } from './action-payload.js';

export function basisFromRequest(request: ActionRequest): { id: string; basis: CompilationBasis } {
  const id = requireString(request.payload, 'basis_id');
  const supplied = requireRecord(request.payload, 'basis') as unknown as CompilationBasis;
  const basis = createCompilationBasis(supplied as CompilationBasisInput);
  if (
    supplied.basisDigest !== basis.basisDigest ||
    supplied.effectiveClassification !== basis.effectiveClassification
  ) {
    refuseDocument('KF-DOC-BASIS-001', 'supplied Basis digest does not match canonical contents', {
      basisId: id,
    });
  }
  return { id, basis };
}

export async function assertBasisMatchesDatabase(
  tx: Tx,
  basis: CompilationBasis,
  targetObjectId: string,
): Promise<void> {
  const root = await tx.maybeOne<{
    object_id: string;
    revision_digest: string;
    classification: string;
  }>(
    `select s.object_id, r.revision_digest, o.classification
       from content.composition_revision r
       join content.document_subject s on s.id = r.composition_id
       join core.object o on o.id = s.object_id
      where r.id = $1`,
    [basis.rootCompositionRevisionId],
  );
  if (root?.object_id !== targetObjectId) {
    refuseDocument('KF-DOC-BASIS-002', 'Basis root is not the targeted document composition', {
      targetObjectId,
      rootCompositionRevisionId: basis.rootCompositionRevisionId,
    });
  }
  for (const revision of basis.fragmentRevisions) {
    const stored = await tx.maybeOne<{ revision_digest: string; classification: string }>(
      'select revision_digest, classification from content.authored_fragment_revision where id = $1',
      [revision.id],
    );
    if (
      stored?.revision_digest !== revision.revisionDigest ||
      stored.classification !== revision.classification
    ) {
      refuseDocument('KF-DOC-BASIS-003', 'Basis fragment does not match visible stored revision', {
        revisionId: revision.id,
      });
    }
  }
  for (const revision of basis.compositionRevisions) {
    const stored = await tx.maybeOne<{ revision_digest: string; classification: string }>(
      `select r.revision_digest, o.classification
         from content.composition_revision r
         join content.document_subject s on s.id = r.composition_id
         join core.object o on o.id = s.object_id
        where r.id = $1`,
      [revision.id],
    );
    if (
      stored?.revision_digest !== revision.revisionDigest ||
      stored.classification !== revision.classification
    ) {
      refuseDocument(
        'KF-DOC-BASIS-004',
        'Basis composition does not match visible stored revision',
        {
          revisionId: revision.id,
        },
      );
    }
  }
  for (const binding of basis.bindings) {
    const stored = await tx.maybeOne<{ binding_digest: string; classification: string }>(
      `select b.binding_digest, o.classification
         from content.typed_binding b
         join core.object o on o.id = b.object_id
        where b.id = $1`,
      [binding.id],
    );
    if (
      stored?.binding_digest !== binding.bindingDigest ||
      stored.classification !== binding.sourceClassification
    ) {
      refuseDocument('KF-DOC-BASIS-005', 'Basis binding does not match visible stored binding', {
        bindingId: binding.id,
      });
    }
  }
}
