import { describe, expect, it } from 'vitest';
import type { DocumentWorkspace } from '../../../lib/api.js';
import { buildDocumentProposalInput } from './workbench-proposal.js';

const workspace: DocumentWorkspace = {
  status: 'ready',
  target: {
    kind: 'authored_fragment',
    objectId: 'target-1',
    subjectId: 'subject-1',
    stableKey: 'constitution.fragment',
    documentPolicy: 'ordinary',
    baseRevisionId: 'revision-1',
    rowVersion: '7',
    classification: 'internal',
    holderId: 'holder-1',
    holder: {
      kind: 'fabric_native',
      id: 'holder-1',
      artifactVersionId: 'artifact-version-1',
      contentDigest: 'a'.repeat(64),
      mediaType: 'text/markdown',
    },
    contentDigest: 'a'.repeat(64),
    mediaType: 'text/markdown',
  },
  basis: {
    id: 'basis-1',
    digest: 'b'.repeat(64),
    effectiveClassification: 'internal',
    finalizedAt: '2026-08-15T12:00:00.000Z',
    targetProfiles: [],
  },
  compilation: null,
  projections: [],
  composition: { rootRevisionId: '', nodes: [], inputs: [] },
  navigation: { backlinks: [], traceability: [], adr: [], topics: [] },
  semanticDiff: { status: 'unavailable' },
};

const operation = {
  operation: 'replace_fragment_source',
  media_type: 'text/markdown',
  classification: 'internal',
  holder_id: 'holder-2',
  previous_holder_id: 'holder-1',
  holder: {
    kind: 'fabric_native',
    artifact_version_id: 'artifact-version-2',
    content_digest: 'c'.repeat(64),
  },
};

describe('document workbench proposal builder', () => {
  it('copies every exact workspace precondition into the typed submission', () => {
    expect(
      buildDocumentProposalInput({
        workspace,
        operationJson: JSON.stringify(operation),
        reason: ' review ',
        attemptId: 'proposal-1',
      }),
    ).toMatchObject({
      proposalId: 'proposal-1',
      basisId: 'basis-1',
      basisDigest: 'b'.repeat(64),
      targetObjectId: 'target-1',
      baseRevisionId: 'revision-1',
      targetRowVersion: '7',
      reason: 'review',
      operation,
      proposalKind: 'source_patch',
    });
  });

  it('maps document compositions to semantic operation proposals', () => {
    const compositionOperation = {
      operation: 'replace_composition_inputs',
      classification: 'internal',
      holder_id: 'holder-2',
      previous_holder_id: 'holder-1',
      holder: {
        kind: 'fabric_native',
        artifact_version_id: 'artifact-version-2',
        content_digest: 'c'.repeat(64),
      },
      inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: 'revision-fragment-1' }],
    };

    expect(
      buildDocumentProposalInput({
        workspace: {
          ...workspace,
          target: {
            ...workspace.target,
            kind: 'document_composition',
            baseRevisionId: 'composition-revision-1',
          },
          composition: { rootRevisionId: 'composition-revision-1', nodes: [], inputs: [] },
        },
        operationJson: JSON.stringify(compositionOperation),
        reason: '',
        attemptId: 'proposal-2',
      }),
    ).toMatchObject({
      proposalKind: 'semantic_operations',
      baseRevisionId: 'composition-revision-1',
      operation: compositionOperation,
    });
  });

  it('refuses ambiguous workspace state and a stale previous Holder', () => {
    expect(() =>
      buildDocumentProposalInput({
        workspace: { status: 'ambiguous' },
        operationJson: JSON.stringify(operation),
        reason: '',
        attemptId: 'proposal-1',
      }),
    ).toThrow(/exact finalized target/);
    expect(() =>
      buildDocumentProposalInput({
        workspace,
        operationJson: JSON.stringify({ ...operation, previous_holder_id: 'stale-holder' }),
        reason: '',
        attemptId: 'proposal-1',
      }),
    ).toThrow(/exact current Holder/);
  });
});
