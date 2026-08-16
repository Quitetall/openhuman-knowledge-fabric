import { describe, expect, it } from 'vitest';
import { ML_LINEAGE_MEMBER_ROLES, isOpaqueReferenceToken } from '@kf/ml-registry/contracts';
import { parseRunRoute, projectionQuery } from './run-route';

describe('ML run route shared validation contracts', () => {
  it('uses the registry opaque-reference guard for route segments', () => {
    expect(isOpaqueReferenceToken('training-run:encoder-2026-08')).toBe(true);
    expect(
      parseRunRoute({
        authorityId: 'training-run%3Aencoder-2026-08',
        revisionId: 'r01',
      }),
    ).toEqual({
      authorityId: 'training-run:encoder-2026-08',
      revisionId: 'r01',
      path: '/ml/runs/training-run:encoder-2026-08/revisions/r01',
    });
    expect(parseRunRoute({ authorityId: 'bad%20space', revisionId: 'r01' })).toBeUndefined();
  });

  it('keeps member and digest pagination aligned with shared ML contracts', () => {
    const role = ML_LINEAGE_MEMBER_ROLES[2];
    const query = projectionQuery({
      afterMember: `${role}:7`,
      afterReceiptDigest: 'a'.repeat(64),
      afterSequence: '4',
      afterOrdinal: '3',
    });
    expect(query.get('afterMember')).toBe('parent_model:7');
    expect(query.get('afterReceiptDigest')).toBe('a'.repeat(64));

    const rejected = projectionQuery({
      afterMember: 'subject:7',
      afterReceiptDigest: 'A'.repeat(64),
    });
    expect(rejected.has('afterMember')).toBe(false);
    expect(rejected.has('afterReceiptDigest')).toBe(false);
  });
});
