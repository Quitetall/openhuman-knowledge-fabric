import { describe, expect, it } from 'vitest';
import {
  isRecordVerification,
  recordVerification,
  UNVERIFIED_LABEL,
  VERIFICATION_NOT_VISIBLE_LABEL,
} from './index.js';

describe('record verification, as a reader is told it (KF-SAS-RQ-229, RQ-231)', () => {
  it('reads absence as unverified, in the master record renderer’s words', () => {
    expect(recordVerification(undefined)).toEqual({ verified: false, label: UNVERIFIED_LABEL });
    expect(recordVerification(null)).toEqual({ verified: false, label: UNVERIFIED_LABEL });
    expect(UNVERIFIED_LABEL).toBe('UNVERIFIED — nobody has checked this record');
  });

  it('names who, when and on which basis for a verified record', () => {
    const v = recordVerification({
      basis: 'promoted_in_bulk',
      verifiedAt: new Date('2026-09-20T00:00:00.000Z'),
      verifiedBy: 'person-b',
    });
    expect(v).toEqual({
      verified: true,
      basis: 'promoted_in_bulk',
      verifiedAt: '2026-09-20T00:00:00.000Z',
      verifiedBy: 'person-b',
      label: 'verified promoted in bulk by person-b at 2026-09-20T00:00:00.000Z',
    });
    expect(isRecordVerification(v)).toBe(true);
  });

  it('discloses nothing about a record the reader cannot see, even when handed the facts', () => {
    const v = recordVerification(
      { basis: 'reviewed_individually', verifiedAt: '2026-09-20T00:00:00.000Z', verifiedBy: 'x' },
      { visible: false },
    );
    expect(v).toEqual({ verified: false, label: VERIFICATION_NOT_VISIBLE_LABEL });
    expect(JSON.stringify(v)).not.toContain('reviewed');
  });

  it('refuses a basis nobody can name', () => {
    expect(() =>
      recordVerification({ basis: 'looked_at_it', verifiedAt: 'now', verifiedBy: 'x' }),
    ).toThrow(/unknown verification basis/);
  });

  it('rejects a label that says more, or less, than the facts', () => {
    expect(isRecordVerification({ verified: false, label: 'checked' })).toBe(false);
    expect(isRecordVerification({ verified: false })).toBe(false);
    expect(
      isRecordVerification({
        verified: true,
        basis: 'promoted_in_bulk',
        verifiedAt: 't',
        verifiedBy: 'p',
        label: 'verified reviewed individually by p at t',
      }),
    ).toBe(false);
    expect(isRecordVerification(undefined)).toBe(false);
  });
});
