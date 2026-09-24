import { record } from './validation';

/**
 * Whether anybody has verified a record, as the API states it (KF-SAS-RQ-229).
 *
 * The API sends the label the reader is shown — produced by `recordVerification` in
 * `@kf/domain`, the same words the master record uses — and this page displays it. Parsing fails
 * CLOSED: a member or hit whose verification is missing, malformed, or claims to be verified
 * without the facts that would make it so is shown as unverified. A page that guessed "checked"
 * would be the one place the label could lie in the reader's favour.
 */
export interface Verification {
  readonly verified: boolean;
  readonly label: string;
  readonly basis?: 'reviewed_individually' | 'promoted_in_bulk';
}

/** Restated from `@kf/domain` so the web bundle stays free of it; a test holds the two equal. */
export const UNVERIFIED_LABEL = 'UNVERIFIED — nobody has checked this record';

const BASES = new Set(['reviewed_individually', 'promoted_in_bulk']);

export function parseVerification(value: unknown): Verification {
  const v = record(value);
  const label = v?.['label'];
  if (
    v?.['verified'] === true &&
    typeof label === 'string' &&
    label.startsWith('verified ') &&
    typeof v['basis'] === 'string' &&
    BASES.has(v['basis']) &&
    typeof v['verifiedAt'] === 'string' &&
    typeof v['verifiedBy'] === 'string'
  ) {
    return { verified: true, label, basis: v['basis'] as NonNullable<Verification['basis']> };
  }
  return {
    verified: false,
    label: typeof label === 'string' && label.startsWith('UNVERIFIED') ? label : UNVERIFIED_LABEL,
  };
}
