/**
 * Damm check digit — OH-DOC-000001-3 R01 Appendix A and rule R7.
 *
 * R7: "The final enterprise-ID digit is a Damm check digit. Invalid check digits shall be
 * rejected at entry and import."
 *
 * Before this module existed, `grep -rni "damm\|check.digit"` across this repository returned
 * zero matches. `ontology/meta.yaml` validated the *shape* of an enterprise identifier and
 * nothing validated the digit, so `OH-DOC-000001-4` — one digit wrong on this organisation's
 * own registry — matched every pattern in the system and would have been stored.
 *
 * WHY THE TABLE IS DUPLICATED HERE. `registries/<instance>/damm.yaml` is canonical. This constant
 * is a copy, and `checkDammTableMatchesSource()` in registry-pack.ts asserts they are identical
 * on every build. The alternative — reading the YAML at module load — would put filesystem IO
 * and a parse behind a function that a database import loop calls per row, and would make this
 * module unusable in any context without the source tree. A checked copy costs one assertion;
 * an unchecked copy is how two tables drift.
 */

/**
 * Rows are the running interim value, columns the digit being consumed.
 *
 * The property that makes this work is total anti-symmetry: every row and every column is a
 * permutation of 0-9, and the diagonal is zero. That is what detects every single-digit error
 * and every adjacent transposition without positional weighting. `isAntiSymmetricQuasigroup`
 * checks it rather than trusting the transcription.
 */
export const DAMM_TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

/** The 19 namespaces that use the enterprise grammar. RCD is excluded — it has its own (§9.4). */
export const ENTERPRISE_NAMESPACES = [
  'ITM',
  'DOC',
  'INTF',
  'BIND',
  'SWC',
  'DAT',
  'MDL',
  'REQ',
  'RSK',
  'TST',
  'CHG',
  'ADR',
  'BSL',
  'RLS',
  'QEV',
  'EQP',
  'SUP',
  'LOT',
  'WRK',
] as const;

const ENTERPRISE_RE = new RegExp(`^OH-(${ENTERPRISE_NAMESPACES.join('|')})-([0-9]{6})-([0-9])$`);
const RECORD_RE = /^OH-RCD-([0-9]{4})-([0-9]{6})-([0-9])$/;
const SERIAL_RE = /^OH-SN-([0-9]{9})-([0-9])$/;

/**
 * The check digit for a payload of decimal digits.
 *
 * Consume left to right from interim value 0; the final interim value is the check digit.
 * Throws on a non-digit rather than coercing: `Number('x')` is NaN, and NaN as a table index
 * yields `undefined`, which would silently produce a wrong digit instead of an error.
 */
export function dammCheck(payload: string): number {
  let interim = 0;
  for (const ch of payload) {
    const d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) throw new Error(`dammCheck: '${payload}' contains a non-digit`);
    interim = DAMM_TABLE[interim]![d]!;
  }
  return interim;
}

/** True when payload+check consumes to zero — the validation form of the same walk. */
export function dammValid(payloadWithCheck: string): boolean {
  return dammCheck(payloadWithCheck) === 0;
}

/** Structural check on the table itself. A transposed cell fails at least one of the three. */
export function isAntiSymmetricQuasigroup(table: readonly (readonly number[])[]): boolean {
  if (table.length !== 10 || table.some((r) => r.length !== 10)) return false;
  const full = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].join(',');
  const rowsOk = table.every((r) => [...r].sort((a, b) => a - b).join(',') === full);
  const colsOk = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every(
    (c) =>
      table
        .map((r) => r[c]!)
        .sort((a, b) => a - b)
        .join(',') === full,
  );
  const diagOk = table.every((r, i) => r[i] === 0);
  return rowsOk && colsOk && diagOk;
}

export type IdentifierKind = 'enterprise' | 'record' | 'serial';

export interface IdentifierVerdict {
  readonly valid: boolean;
  readonly kind?: IdentifierKind;
  /** Why it was rejected, phrased for whoever typed it. Absent when valid. */
  readonly reason?: string;
}

/**
 * Validate an OpenHuman identifier: grammar first, then the check digit.
 *
 * Both halves are required. Appendix B.1 says so directly — "Regex conformance is necessary but
 * not sufficient" — and the two failures read differently to a user: a shape error is usually a
 * wrong format, a digit error is usually a typo or a transposition in transcription.
 *
 * The Damm payload differs by kind, which is the part that is easy to get wrong:
 *   enterprise  digit covers the six-digit sequence only, NOT the namespace
 *   record      digit covers YYYY + NNNNNN, ten digits (§9.4)
 *   serial      digit covers the nine-digit sequence (§10.1)
 */
export function validateIdentifier(id: string): IdentifierVerdict {
  const enterprise = ENTERPRISE_RE.exec(id);
  if (enterprise !== null) {
    const [, , sequence, check] = enterprise;
    return dammCheck(sequence! + check!) === 0
      ? { valid: true, kind: 'enterprise' }
      : {
          valid: false,
          kind: 'enterprise',
          reason: `check digit is ${check}, expected ${dammCheck(sequence!)}`,
        };
  }

  const record = RECORD_RE.exec(id);
  if (record !== null) {
    const [, year, sequence, check] = record;
    return dammCheck(year! + sequence! + check!) === 0
      ? { valid: true, kind: 'record' }
      : {
          valid: false,
          kind: 'record',
          reason: `check digit is ${check}, expected ${dammCheck(year! + sequence!)}`,
        };
  }

  const serial = SERIAL_RE.exec(id);
  if (serial !== null) {
    const [, sequence, check] = serial;
    return dammCheck(sequence! + check!) === 0
      ? { valid: true, kind: 'serial' }
      : {
          valid: false,
          kind: 'serial',
          reason: `check digit is ${check}, expected ${dammCheck(sequence!)}`,
        };
  }

  // Distinguish "no grammar matched" from "namespace not allocated", because they are
  // different mistakes. §8's rule is that an identifier absent from the registry does not
  // exist, and a reader who typed OH-XYZ-000001-3 needs to be told which half was wrong.
  const shaped = /^OH-([A-Z]{2,5})-[0-9]{6}-[0-9]$/.exec(id);
  if (shaped !== null) {
    return {
      valid: false,
      reason:
        `'${shaped[1]}' is not an allocated namespace. ` +
        `Allocated: ${ENTERPRISE_NAMESPACES.join(', ')} (RCD uses the record grammar).`,
    };
  }
  return { valid: false, reason: 'matches no allocated identifier grammar' };
}

/** Format an enterprise identifier from its parts, computing the check digit. */
export function formatEnterpriseId(namespace: string, sequence: number): string {
  if (!(ENTERPRISE_NAMESPACES as readonly string[]).includes(namespace)) {
    throw new Error(`formatEnterpriseId: '${namespace}' is not an allocated namespace`);
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new Error(`formatEnterpriseId: sequence ${sequence} outside 0-999999`);
  }
  const padded = String(sequence).padStart(6, '0');
  return `OH-${namespace}-${padded}-${dammCheck(padded)}`;
}
