/**
 * Whether anybody has verified a record, as every reading of it states it (KF-SAS-RQ-228 to
 * RQ-232, ADR 0031).
 *
 * The fact lives in `core.object_verification`, beside the record: absence of a row is the
 * unverified state. This is the vocabulary every surface that shows a record uses to say so —
 * projections, the Object View, the master record, agent reads, search hits — so the words a
 * reader sees are one function's output rather than five renderers' opinions.
 *
 * Both states carry a label, and that asymmetry is the requirement. An unverified record is
 * marked because otherwise it borrows the credibility of the checked records around it
 * (RQ-229). A verified one names who and how, because "reviewed individually" and "promoted in
 * bulk" are different facts (RQ-231) and a reader who cannot tell them apart has been told the
 * weaker one.
 */

export const VERIFICATION_BASES = ['reviewed_individually', 'promoted_in_bulk'] as const;

export type VerificationBasis = (typeof VERIFICATION_BASES)[number];

/** A record nobody has checked. The master record renderer's wording since `20260918000100`. */
export const UNVERIFIED_LABEL = 'UNVERIFIED — nobody has checked this record';

/**
 * A record this reader can no longer see — a withdrawn member of their master record. Its
 * verification is deliberately not looked up: what a session cannot see, it does not learn
 * anything about, including whether somebody checked it. It is labelled unverified because
 * nothing the reader can see says otherwise, and it says why rather than claiming nobody did.
 */
export const VERIFICATION_NOT_VISIBLE_LABEL =
  'UNVERIFIED — no verification is visible to this reader';

export type RecordVerification =
  | {
      readonly verified: false;
      readonly label: typeof UNVERIFIED_LABEL | typeof VERIFICATION_NOT_VISIBLE_LABEL;
    }
  | {
      readonly verified: true;
      readonly basis: VerificationBasis;
      /** ISO-8601, the database's clock (`20260924000300`). */
      readonly verifiedAt: string;
      /** The person who verified it. Never the record's creator (`object_verification_write`). */
      readonly verifiedBy: string;
      readonly label: string;
    };

/** The facts as a `core.object_verification` row holds them. */
export interface VerificationFacts {
  readonly basis: string;
  readonly verifiedAt: string | Date;
  readonly verifiedBy: string;
}

function isBasis(value: unknown): value is VerificationBasis {
  return (VERIFICATION_BASES as readonly unknown[]).includes(value);
}

function verifiedLabel(basis: VerificationBasis, verifiedBy: string, verifiedAt: string): string {
  const how = basis === 'reviewed_individually' ? 'reviewed individually' : 'promoted in bulk';
  return `verified ${how} by ${verifiedBy} at ${verifiedAt}`;
}

/**
 * Build what a reader is told from a verification row, or from its absence.
 *
 * `undefined`/`null` is the unverified state, not "unknown". `visible: false` is for a record
 * the reader cannot see; any facts passed with it are ignored rather than disclosed. An unknown
 * basis is refused: a verification whose basis nobody can name is not one this code may repeat.
 */
export function recordVerification(
  facts: VerificationFacts | null | undefined,
  options: { readonly visible?: boolean } = {},
): RecordVerification {
  if (options.visible === false) return { verified: false, label: VERIFICATION_NOT_VISIBLE_LABEL };
  if (facts === undefined || facts === null) return { verified: false, label: UNVERIFIED_LABEL };
  if (!isBasis(facts.basis)) {
    throw new Error(`unknown verification basis: ${String(facts.basis)}`);
  }
  const verifiedAt =
    facts.verifiedAt instanceof Date ? facts.verifiedAt.toISOString() : facts.verifiedAt;
  return {
    verified: true,
    basis: facts.basis,
    verifiedAt,
    verifiedBy: facts.verifiedBy,
    label: verifiedLabel(facts.basis, facts.verifiedBy, verifiedAt),
  };
}

/**
 * True only for a verification whose label is the one its facts produce. A surface that
 * receives a verification from elsewhere uses this to refuse one that says less than it should
 * — an unverified record with a reassuring label, or a verified one with the basis dropped.
 */
export function isRecordVerification(value: unknown): value is RecordVerification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['verified'] === false) {
    return v['label'] === UNVERIFIED_LABEL || v['label'] === VERIFICATION_NOT_VISIBLE_LABEL;
  }
  if (v['verified'] !== true) return false;
  const { basis, verifiedAt, verifiedBy, label } = v;
  return (
    isBasis(basis) &&
    typeof verifiedAt === 'string' &&
    typeof verifiedBy === 'string' &&
    label === verifiedLabel(basis, verifiedBy, verifiedAt)
  );
}
