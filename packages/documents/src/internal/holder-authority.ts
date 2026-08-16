import type { ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';
import { requireString } from '@kf/record-atoms';
import type { DocumentClassification, SourceHolder } from '../compiler.js';
import { refuseDocument } from './action-payload.js';
import { sourceHolderFromPayload } from './holder-contract.js';
import { classificationRank, requireDocumentClassification } from './target-classification.js';
import { insertSourceHolder, type HolderRow } from './holder-store.js';

export async function currentHolder(tx: Tx, objectId: string): Promise<HolderRow> {
  const row = await tx.maybeOne<HolderRow>(
    `select s.id as subject_id, h.id as holder_id, h.holder_kind,
            h.fabric_artifact_version_id, h.git_repository, h.git_commit_sha, h.git_path,
            h.git_submodule_commit_sha, h.external_authority, h.external_revision,
            h.content_digest
       from content.document_subject s
       join content.document_source_holder h on h.id = s.current_holder_id
      where s.object_id = $1`,
    [objectId],
  );
  if (row === undefined) {
    return refuseDocument('KF-DOC-001', 'document target has no visible current Source Holder', {
      objectId,
    });
  }
  return row;
}

export async function assertSameSourceAuthority(
  tx: Tx,
  current: HolderRow,
  proposed: SourceHolder,
  classification: DocumentClassification,
): Promise<void> {
  if (current.holder_kind !== proposed.kind) {
    refuseDocument(
      'KF-DOC-HOLDER-001',
      'source revision cannot change Holder kind; use change_document_source_holder',
    );
  }
  if (proposed.kind === 'git') {
    if (current.git_repository !== proposed.repository || current.git_path !== proposed.path) {
      refuseDocument(
        'KF-DOC-HOLDER-002',
        'Git source revision must retain repository and path authority',
      );
    }
    return;
  }
  if (proposed.kind === 'external') {
    if (current.external_authority !== proposed.authority) {
      refuseDocument(
        'KF-DOC-HOLDER-003',
        'external source revision must retain its named authority',
      );
    }
    return;
  }
  const authority = await tx.maybeOne<{
    artifact_organization_id: string;
    artifact_classification: string;
    subject_organization_id: string;
  }>(
    `select artifact_object.organization_id as artifact_organization_id,
            artifact_object.classification as artifact_classification,
            subject_object.organization_id as subject_organization_id
       from content.artifact_version proposed
       join core.object artifact_object on artifact_object.id = proposed.artifact_id
       join content.document_subject subject on subject.id = $1
       join core.object subject_object on subject_object.id = subject.object_id
      where proposed.id = $2 and proposed.sha256 = $3`,
    [current.subject_id, proposed.artifactVersionId, proposed.contentDigest],
  );
  if (
    authority === undefined ||
    authority.artifact_organization_id !== authority.subject_organization_id
  ) {
    refuseDocument(
      'KF-DOC-HOLDER-004',
      'fabric-native source revision must name exact KF bytes in the subject organization',
    );
  }
  if (classificationRank(classification) < classificationRank(authority.artifact_classification)) {
    refuseDocument(
      'KF-DOC-HOLDER-007',
      'document revision classification cannot be below its fabric-native source artifact',
    );
  }
}

export async function assertRevisionHolder(
  tx: Tx,
  payload: Readonly<Record<string, unknown>> | undefined,
  objectId: string,
): Promise<void> {
  const current = await currentHolder(tx, objectId);
  if (current.holder_id !== requireString(payload, 'previous_holder_id')) {
    refuseDocument('KF-DOC-HOLDER-005', 'source revision must name the current exact Holder', {
      objectId,
      currentHolderId: current.holder_id,
    });
  }
  if (requireString(payload, 'holder_id') === current.holder_id) {
    refuseDocument('KF-DOC-HOLDER-006', 'source revision requires a new Holder snapshot id', {
      objectId,
    });
  }
  await assertSameSourceAuthority(
    tx,
    current,
    sourceHolderFromPayload(payload, current.subject_id),
    requireDocumentClassification(payload),
  );
}

export async function appendRevisionHolder(
  tx: Tx,
  request: ActionRequest,
  objectId: string,
  actionId: string,
  payload: Readonly<Record<string, unknown>> | undefined = request.payload,
): Promise<HolderRow> {
  const current = await currentHolder(tx, objectId);
  const holderId = requireString(payload, 'holder_id');
  await insertSourceHolder(tx, {
    id: holderId,
    subjectId: current.subject_id,
    previousHolderId: current.holder_id,
    holder: sourceHolderFromPayload(payload, current.subject_id),
    conversionLoss: [],
    migrationReason: null,
    reversibleMigrationPlan: null,
    actorId: request.actorId,
    actionId,
  });
  await tx.query(
    'update content.document_subject set current_holder_id = $2 where object_id = $1',
    [objectId, holderId],
  );
  return currentHolder(tx, objectId);
}
