import type { Verification } from '../../lib/api/verification';

/**
 * The verification line under a record, wherever the record appears (KF-SAS-RQ-229).
 *
 * `class="unverified"` is the master record renderer's class for the same state, so one rule
 * finds every unchecked record whichever surface drew it. Stated for both states: a verified
 * record names who and how, because "reviewed individually" and "promoted in bulk" differ.
 */
export function VerificationNote({ verification }: { readonly verification: Verification }) {
  return (
    <p
      className={verification.verified ? 'kf-verification' : 'kf-verification unverified'}
      data-verified={verification.verified ? 'true' : 'false'}
    >
      {verification.label}
    </p>
  );
}
