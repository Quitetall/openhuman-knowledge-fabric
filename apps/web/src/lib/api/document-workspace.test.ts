import { describe, expect, it } from 'vitest';
import { parseDocumentWorkspace } from './document-workspace.js';

const ready = {
  status: 'ready',
  target: {
    kind: 'authored_fragment',
    objectId: 'target-1',
    subjectId: 'subject-1',
    stableKey: 'document:target-1',
    documentPolicy: 'ordinary',
    baseRevisionId: 'revision-1',
    rowVersion: '4',
    classification: 'internal',
    holderId: 'holder-1',
    holder: {
      kind: 'fabric_native',
      id: 'holder-1',
      artifactVersionId: 'artifact-1',
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
    targetProfiles: [{ target: 'html', capabilities: ['human_readable'] }],
  },
  compilation: {
    runId: 'run-1',
    status: 'succeeded',
    draftOnly: true,
    semanticDigest: 'c'.repeat(64),
    diagnostics: [{ severity: 'warning', code: 'draft', message: 'Draft only' }],
    conversionLoss: [{ code: 'loss', path: '/one', message: 'One conversion' }],
    recordedAt: '2026-08-15T13:00:00.000Z',
  },
  projections: [
    {
      id: 'view-1',
      target: 'html',
      mediaType: 'text/html',
      artifactVersionId: 'artifact-1',
      contentDigest: 'd'.repeat(64),
      effectiveClassification: 'internal',
    },
  ],
  composition: {
    rootRevisionId: 'composition-1',
    nodes: [
      {
        revisionId: 'composition-1',
        subjectId: 'composition-subject-1',
        objectId: 'composition-object-1',
        title: 'Constitution root',
        stableKey: 'constitution.root',
        revisionDigest: 'e'.repeat(64),
        classification: 'internal',
        createdAt: '2026-08-15T12:30:00.000Z',
      },
    ],
    inputs: [
      {
        compositionRevisionId: 'composition-1',
        ordinal: 1,
        role: 'fragment',
        targetId: 'revision-1',
        targetTitle: 'Authority',
        contentDigest: 'a'.repeat(64),
      },
    ],
  },
  navigation: {
    backlinks: [
      {
        id: 'relation-1',
        relationType: 'implements',
        direction: 'inbound',
        peerObjectId: 'adr-1',
        peerObjectType: 'adr_decision',
        peerTitle: 'Compiler ADR',
        recordedAt: '2026-08-15T12:45:00.000Z',
      },
    ],
    traceability: [
      {
        id: 'relation-1',
        relationType: 'implements',
        direction: 'inbound',
        peerObjectId: 'adr-1',
        peerObjectType: 'adr_decision',
        peerTitle: 'Compiler ADR',
        recordedAt: '2026-08-15T12:45:00.000Z',
      },
    ],
    adr: [
      {
        decisionId: 'adr-1',
        title: 'Compiler ADR',
        lifecycleState: 'accepted',
        latestProgressKind: 'implemented',
        topicKey: 'documents',
      },
    ],
    topics: [
      {
        decisionId: 'adr-1',
        topicKey: 'documents',
        title: 'Compiler ADR',
        lifecycleState: 'accepted',
      },
    ],
  },
  semanticDiff: {
    status: 'available',
    fromRunId: 'run-0',
    toRunId: 'run-1',
    changes: [{ kind: 'changed', path: '/title', before: 'old', after: 'new' }],
    truncated: false,
  },
};

describe('document workspace decoder', () => {
  it('accepts an exact ready workspace and explicit fail-closed states', () => {
    expect(parseDocumentWorkspace(ready)).toEqual(ready);
    expect(parseDocumentWorkspace({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(parseDocumentWorkspace({ status: 'ambiguous' })).toEqual({ status: 'ambiguous' });
  });

  it('rejects concealed target facts and malformed diagnostics', () => {
    expect(() => parseDocumentWorkspace({ status: 'ambiguous', target: ready.target })).toThrow();
    expect(() =>
      parseDocumentWorkspace({
        ...ready,
        compilation: { ...ready.compilation, diagnostics: [{ severity: 'clean' }] },
      }),
    ).toThrow();
  });
});
