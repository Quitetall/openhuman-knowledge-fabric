import { describe, expect, it } from 'vitest';
import { parseRunProjection } from './parse-run-projection';

const reference = {
  kind: 'run',
  authorityId: 'run-authority',
  revisionId: 'revision-1',
  sha256: 'a'.repeat(64),
  classificationId: 'internal',
  policyId: 'ml-default',
};

function projectionWithMemberRole(role: string) {
  return {
    schemaVersion: 'kf.ml.run-projection.v1',
    run: reference,
    lineage: {
      lineageDigest: 'b'.repeat(64),
      recordedAt: '2026-08-14T12:01:00.000Z',
      code: { ...reference, kind: 'code' },
      recipe: { ...reference, kind: 'recipe' },
      environment: { ...reference, kind: 'environment' },
      metricPolicy: { ...reference, kind: 'metric_policy' },
      members: {
        items: [{ role, ordinal: 1, reference: { ...reference, kind: role } }],
        page: { limit: 100, afterMember: null, nextAfterMember: null },
      },
    },
    metrics: {
      events: [],
      page: { limit: 100, afterSequence: '0', nextAfterSequence: null },
    },
    segments: {
      items: [],
      page: { limit: 100, afterOrdinal: 0, nextAfterOrdinal: null },
    },
    seal: null,
    promotions: {
      receipts: [],
      page: { limit: 100, afterReceiptDigest: null, nextAfterReceiptDigest: null },
    },
  };
}

describe('parseRunProjection', () => {
  it('accepts lineage roles from the shared ML contract', () => {
    expect(
      parseRunProjection(projectionWithMemberRole('parent_model')).lineage.members.items,
    ).toEqual([
      {
        role: 'parent_model',
        ordinal: 1,
        reference: { ...reference, kind: 'parent_model' },
      },
    ]);
  });

  it('rejects lineage roles outside the shared ML contract', () => {
    expect(() => parseRunProjection(projectionWithMemberRole('subject'))).toThrow(
      /ML run projection did not match v1 contract/,
    );
  });
});
