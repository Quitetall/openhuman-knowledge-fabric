import { describe, expect, it } from 'vitest';
import type { DocumentDetail } from '../../../lib/api.js';
import { documentProvenanceView } from './workbench-provenance.js';

const DIGEST = 'a'.repeat(64);
const REVISION_DIGEST = 'b'.repeat(64);

function documentWith(sourceProvenance: DocumentDetail['sourceProvenance']): DocumentDetail {
  return {
    id: 'document-1',
    title: 'Document Constitution',
    documentNumber: 'OH-DOC-000002-1',
    revision: 'R01',
    documentClass: 'policy',
    lifecycleState: 'draft',
    rowVersion: '1',
    owningRole: 'technical_authority',
    contentVersionId: 'artifact-version-1',
    mediaType: 'text/markdown',
    sha256: DIGEST,
    sizeBytes: 42,
    parser: 'pandoc',
    parserVersion: '3.8',
    projectionContract: 'kf.pandoc-atoms.v2',
    conversionLoss: [],
    contentDigest: REVISION_DIGEST,
    parsedBlockCount: 0,
    parsedBlocks: [],
    sourceProvenance,
  };
}

describe('document source provenance workbench model', () => {
  it('keeps exact Holder, revision, artifact, action, and timestamp evidence', () => {
    const view = documentProvenanceView(
      documentWith({
        status: 'recorded',
        holderKind: 'fabric_native',
        fragmentId: 'fragment-1',
        fragmentRevisionId: 'fragment-revision-1',
        stableKey: 'openhuman.constitution.OH-DOC-000002-1',
        documentPolicy: 'controlled',
        holderId: 'holder-1',
        artifactVersionId: 'artifact-version-1',
        contentDigest: DIGEST,
        mediaType: 'text/markdown',
        classification: 'internal',
        revisionState: 'active',
        revisionDigest: REVISION_DIGEST,
        holderRecordedAt: '2026-08-14T12:00:00.123Z',
        holderRecordedByAction: 'action-holder-1',
        revisionCreatedAt: '2026-08-14T12:00:01.456Z',
        revisionCreatedByAction: 'action-revision-1',
      }),
    );

    expect(view).toMatchObject({
      status: 'recorded',
      contentVersionId: 'artifact-version-1',
      holder: {
        kind: 'fabric native',
        id: 'holder-1',
        recordedAt: '2026-08-14 12:00:00.123Z',
        recordedByAction: 'action-holder-1',
      },
      revision: {
        id: 'fragment-revision-1',
        state: 'active',
        digest: REVISION_DIGEST,
        createdAt: '2026-08-14 12:00:01.456Z',
        createdByAction: 'action-revision-1',
      },
      artifact: { id: 'artifact-version-1', digest: DIGEST },
    });
  });

  it('reports ambiguous provenance without inventing a Holder or source revision', () => {
    expect(documentProvenanceView(documentWith({ status: 'ambiguous' }))).toEqual({
      status: 'ambiguous',
      contentVersionId: 'artifact-version-1',
    });
  });
});
