import type { ObjectRow } from '@kf/actions';
import type { Tx } from '@kf/database';
import { requireString } from '@kf/record-atoms';
import type { DocumentClassification } from '../compiler.js';
import { refuseDocument } from './action-payload.js';

export function requireDocumentTarget(
  objects: readonly ObjectRow[],
  allowedTypes: ReadonlySet<string>,
  actionType: string,
): ObjectRow {
  if (objects.length !== 1 || !allowedTypes.has(objects[0]!.object_type)) {
    return refuseDocument(
      'KF-DOC-TARGET-001',
      `${actionType} requires exactly one document target`,
      {
        allowedTypes: [...allowedTypes],
        actualTypes: objects.map((object) => object.object_type),
      },
    );
  }
  return objects[0]!;
}

export const FRAGMENT_TARGET = new Set(['authored_fragment']);
export const COMPOSITION_TARGET = new Set(['document_composition']);
export const DOCUMENT_TARGET = new Set(['authored_fragment', 'document_composition']);

export const CLASSIFICATION_RANK: Readonly<Record<DocumentClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function documentClassification(
  value: string,
  field = 'classification',
): DocumentClassification {
  if (Object.hasOwn(CLASSIFICATION_RANK, value)) return value as DocumentClassification;
  throw new Error(`${field} must be public, internal, confidential, or restricted`);
}

export function requireDocumentClassification(
  payload: Readonly<Record<string, unknown>> | undefined,
  key = 'classification',
): DocumentClassification {
  return documentClassification(requireString(payload, key), key);
}

export function classificationRank(value: string): number {
  return CLASSIFICATION_RANK[documentClassification(value)];
}

export async function assertClassificationMayAdvance(
  tx: Tx,
  objectId: string,
  classification: DocumentClassification,
): Promise<void> {
  const row = await tx.one<{ classification: string }>(
    'select classification from core.object where id = $1',
    [objectId],
  );
  if (classificationRank(classification) < classificationRank(row.classification)) {
    refuseDocument('KF-DOC-CLASS-001', 'document classification cannot be lowered by revision', {
      objectId,
      current: row.classification,
      requested: classification,
    });
  }
}
