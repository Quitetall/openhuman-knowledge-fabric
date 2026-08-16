import { formatInstant, formatState } from '@kf/ui';
import type { DocumentDetail } from '../../../lib/api';

export type DocumentProvenanceView =
  | {
      readonly status: 'not_recorded' | 'ambiguous';
      readonly contentVersionId: string | null;
    }
  | {
      readonly status: 'recorded';
      readonly contentVersionId: string | null;
      readonly stableKey: string;
      readonly documentPolicy: string;
      readonly fragmentId: string;
      readonly holder: {
        readonly kind: string;
        readonly id: string;
        readonly recordedAt: string;
        readonly recordedByAction: string;
      };
      readonly revision: {
        readonly id: string;
        readonly state: string;
        readonly digest: string;
        readonly createdAt: string;
        readonly createdByAction: string;
      };
      readonly artifact: {
        readonly id: string;
        readonly digest: string;
        readonly mediaType: string;
        readonly classification: string;
      };
    };

/**
 * Present exact source authority without making absence claims.
 *
 * `not_recorded` and `ambiguous` deliberately stay closed variants: callers cannot render
 * fragments from a partial match or accidentally imply that one candidate is authoritative.
 */
export function documentProvenanceView(document: DocumentDetail): DocumentProvenanceView {
  const provenance = document.sourceProvenance;
  if (provenance.status !== 'recorded') {
    return { status: provenance.status, contentVersionId: document.contentVersionId };
  }
  return {
    status: provenance.status,
    contentVersionId: document.contentVersionId,
    stableKey: provenance.stableKey,
    documentPolicy: formatState(provenance.documentPolicy),
    fragmentId: provenance.fragmentId,
    holder: {
      kind: formatState(provenance.holderKind),
      id: provenance.holderId,
      recordedAt: formatInstant(provenance.holderRecordedAt),
      recordedByAction: provenance.holderRecordedByAction,
    },
    revision: {
      id: provenance.fragmentRevisionId,
      state: formatState(provenance.revisionState),
      digest: provenance.revisionDigest,
      createdAt: formatInstant(provenance.revisionCreatedAt),
      createdByAction: provenance.revisionCreatedByAction,
    },
    artifact: {
      id: provenance.artifactVersionId,
      digest: provenance.contentDigest,
      mediaType: provenance.mediaType,
      classification: formatState(provenance.classification),
    },
  };
}
