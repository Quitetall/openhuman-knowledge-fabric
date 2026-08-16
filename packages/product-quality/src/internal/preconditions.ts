import type { PreconditionCheck } from '@kf/actions';
import { refuse } from './errors.js';

/** A nonconformity closed with no disposition never decided what to do with the material. */
const assertDispositioned: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'nonconformity') continue;
    const row = await tx.one<{ disposition: string | null }>(
      'select disposition from quality.nonconformity where id = $1',
      [o.id],
    );
    if (row.disposition === null) {
      refuse(
        'KF-QMS-001',
        'this nonconformity has no disposition — closing it would leave the affected material undecided',
        { objectId: o.id },
      );
    }
  }
};

const assertEffectivenessShown: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'capa') continue;
    const row = await tx.one<{
      effectiveness_evidence: string | null;
      effectiveness_criterion: string;
    }>('select effectiveness_evidence, effectiveness_criterion from quality.capa where id = $1', [
      o.id,
    ]);
    if (row.effectiveness_evidence === null || row.effectiveness_evidence.trim() === '') {
      refuse(
        'KF-QMS-002',
        'this CAPA has no effectiveness evidence against the criterion it was opened with',
        {
          objectId: o.id,
          criterion: row.effectiveness_criterion,
        },
      );
    }
  }
};

const assertDocumentHasContent: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'controlled_document') continue;
    const row = await tx.one<{ content_version: string | null }>(
      'select content_version from quality.controlled_document where id = $1',
      [o.id],
    );
    if (row.content_version === null) {
      refuse(
        'KF-QMS-003',
        'this document has no content version — there is nothing to make effective',
        {
          objectId: o.id,
        },
      );
    }
  }
};

const assertExecuted: PreconditionCheck = async (tx, _request, objects) => {
  for (const o of objects) {
    if (o.object_type !== 'test_execution') continue;
    const row = await tx.one<{ executed_on: Date | null }>(
      'select executed_on from engineering.test_execution where id = $1',
      [o.id],
    );
    if (row.executed_on === null) {
      refuse('KF-VER-002', 'this execution has no execution time — there is no run to report on', {
        objectId: o.id,
      });
    }
  }
};

export const PRODUCT_QUALITY_PRECONDITIONS: Readonly<Record<string, PreconditionCheck>> = {
  close_nonconformity: assertDispositioned,
  close_capa: assertEffectivenessShown,
  make_document_effective: assertDocumentHasContent,
  record_test_result: assertExecuted,
};
