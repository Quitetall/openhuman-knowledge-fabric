/**
 * What a projection is told about verification, and from where (KF-SAS-RQ-229).
 *
 * Verification is read live under the reader's row security, never from the stored claim. The
 * stored manifest may carry a `verified` block from compilation time; for a member the reader
 * can no longer see — withdrawn, or absent from the live set — repeating it would disclose a
 * fact about a record the reader has lost. These tests hand the mapping a manifest that carries
 * such facts and require that none of them come out.
 */

import { describe, expect, it } from 'vitest';
import { recordVerification, UNVERIFIED_LABEL, VERIFICATION_NOT_VISIBLE_LABEL } from '@kf/domain';
import type { PermissionMember } from '@kf/documents';
import {
  liveVerifications,
  projectionMembersOf,
} from './documents/master-record-projection-route.js';

const stale = {
  at: '2026-01-01T00:00:00.000Z',
  by: 'secret-verifier',
  basis: 'reviewed_individually',
} as const;

const member = (objectId: string, extra: Partial<PermissionMember> = {}): PermissionMember => ({
  objectId,
  objectType: 'decision_record',
  organizationId: 'org',
  classification: 'internal',
  contentDigest: objectId.padStart(64, '0'),
  title: objectId,
  ...extra,
});

describe('projectionMembersOf', () => {
  it('labels a visible, unchecked member UNVERIFIED', () => {
    const [m] = projectionMembersOf(
      { included: [member('a')], withdrawn: [] },
      liveVerifications([member('a')]),
    );
    expect(m!.verification).toEqual({ verified: false, label: UNVERIFIED_LABEL });
  });

  it('takes a verification from the live set, basis and all', () => {
    const live = member('a', {
      verified: { at: '2026-09-20T00:00:00.000Z', by: 'reviewer', basis: 'promoted_in_bulk' },
    });
    const [m] = projectionMembersOf(
      { included: [member('a')], withdrawn: [] },
      liveVerifications([live]),
    );
    expect(m!.verification).toEqual(
      recordVerification({
        basis: 'promoted_in_bulk',
        verifiedAt: '2026-09-20T00:00:00.000Z',
        verifiedBy: 'reviewer',
      }),
    );
  });

  it('never repeats the stored claim’s verification of a record the reader cannot see', () => {
    const members = projectionMembersOf(
      {
        // Both carry a verification from compilation time. Neither is in the live set: the
        // included one has become invisible since, the withdrawn one is withdrawn.
        included: [member('gone', { verified: stale })],
        withdrawn: [member('w', { verified: stale, withdrawnAt: '2026-09-01T00:00:00.000Z' })],
      },
      liveVerifications([member('other')]),
    );
    for (const m of members) {
      expect(m.verification).toEqual({ verified: false, label: VERIFICATION_NOT_VISIBLE_LABEL });
    }
    expect(JSON.stringify(members)).not.toContain('secret-verifier');
  });

  it('does not look up a withdrawn member even when the live set has it', () => {
    const live = member('w', {
      verified: { at: '2026-09-20T00:00:00.000Z', by: 'reviewer', basis: 'promoted_in_bulk' },
    });
    const [m] = projectionMembersOf(
      { included: [], withdrawn: [member('w')] },
      liveVerifications([live]),
    );
    expect(m!.verification.verified).toBe(false);
  });
});
