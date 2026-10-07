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
 * One registry's identifier grammar, compiled from its `grammars.yaml` (KF-SAS-RQ-139, SAS §100.3).
 *
 * THIS MODULE NAMES NO PREFIX AND NO NAMESPACE. It used to: `^OH-` and OpenHuman's namespace list
 * were constants here, so a second registry's identifiers were refused for their prefix before
 * their check digit was read, and `registry-check`'s reject-vector gate was vacuous for any
 * registry but OpenHuman's. The registry directory is the seam (ADR 0006); the grammar is read
 * from it, and the Damm walk — which is the same for every registry — stays here.
 */
export interface IdentifierGrammar {
  /** The enterprise prefix the registry's patterns fix, e.g. `OH-`. */
  readonly prefix: string;
  /** The namespaces the enterprise pattern enumerates, in the pattern's order. */
  readonly enterpriseNamespaces: readonly string[];
  /**
   * Validate an identifier: grammar first, then the check digit.
   *
   * Both halves are required. Appendix B.1 says so directly — "Regex conformance is necessary
   * but not sufficient" — and the two failures read differently to a user: a shape error is
   * usually a wrong format, a digit error is usually a typo or a transposition in transcription.
   */
  validate(id: string): IdentifierVerdict;
  /** Format an enterprise identifier from its parts, computing the check digit. */
  formatEnterprise(namespace: string, sequence: number): string;
}

/** Which digits a grammar's check digit covers (`damm_payload` in grammars.yaml). */
type DammPayload = 'sequence' | 'year_and_sequence';

interface CompiledKind {
  readonly kind: IdentifierKind;
  readonly pattern: RegExp;
  readonly payload: DammPayload;
}

function grammarRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`identifier grammar: ${where} is not a mapping`);
  }
  return value as Record<string, unknown>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a registry's grammar from the parsed `grammars.yaml` (`RegistryPolicy.grammars`).
 *
 * Throws, naming what is missing, when the file does not declare a check-digit grammar this
 * module can apply. `checkRegistryPolicy` turns that into a named failure.
 *
 * The Damm payload differs by kind, which is the part that is easy to get wrong:
 *   enterprise  digit covers the six-digit sequence only, NOT the namespace
 *   record      digit covers YYYY + NNNNNN, ten digits (§9.4)
 *   serial      digit covers the nine-digit sequence (§10.1)
 * Every one of those patterns ends `-<digits>-<check>`, and the record grammar's year is the
 * hyphen field before its sequence, so the payload is read from the identifier's last fields.
 */
export function identifierGrammar(
  grammarsFile: Readonly<Record<string, unknown>>,
): IdentifierGrammar {
  const grammars = grammarRecord(grammarsFile['grammars'], 'grammars');
  const compile = (kind: IdentifierKind): CompiledKind => {
    const g = grammarRecord(grammars[kind], kind);
    if (typeof g['pattern'] !== 'string')
      throw new Error(`identifier grammar: ${kind} has no pattern`);
    if (g['damm_required'] !== true) {
      throw new Error(`identifier grammar: ${kind} does not require a Damm digit`);
    }
    const payload = g['damm_payload'];
    if (payload !== 'sequence' && payload !== 'year_and_sequence') {
      throw new Error(`identifier grammar: ${kind} damm_payload ${String(payload)} is not known`);
    }
    return { kind, pattern: new RegExp(g['pattern']), payload };
  };
  const kinds = (['enterprise', 'record', 'serial'] as const).map(compile);
  const enterprise = kinds[0]!;

  // The enterprise pattern is `^<PREFIX>(<NS>|<NS>|...)-[0-9]{6}-[0-9]$`. registry-check
  // requires the alternation to equal the namespaces declared to use the grammar.
  const shape = /^\^([A-Z][A-Z0-9]*-)\(([A-Z|]+)\)-/.exec(enterprise.pattern.source);
  if (shape === null) {
    throw new Error(
      'identifier grammar: the enterprise pattern does not read as ^<PREFIX>(<NAMESPACES>)-',
    );
  }
  const prefix = shape[1]!;
  const enterpriseNamespaces = Object.freeze(shape[2]!.split('|'));
  const shaped = new RegExp(`^${escapeRegExp(prefix)}([A-Z]{2,5})-[0-9]{6}-[0-9]$`);

  const validate = (id: string): IdentifierVerdict => {
    for (const { kind, pattern, payload } of kinds) {
      if (!pattern.test(id)) continue;
      const fields = id.split('-');
      const check = fields.at(-1)!;
      const sequence = fields.at(-2)!;
      const digits = payload === 'year_and_sequence' ? fields.at(-3)! + sequence : sequence;
      return dammCheck(digits + check) === 0
        ? { valid: true, kind }
        : { valid: false, kind, reason: `check digit is ${check}, expected ${dammCheck(digits)}` };
    }
    // Distinguish "no grammar matched" from "namespace not allocated", because they are
    // different mistakes. §8's rule is that an identifier absent from the registry does not
    // exist, and a reader who typed <PREFIX>XYZ-000001-3 needs to be told which half was wrong.
    const unallocated = shaped.exec(id);
    if (unallocated !== null) {
      return {
        valid: false,
        reason:
          `'${unallocated[1]!}' is not an allocated namespace. ` +
          `Allocated: ${enterpriseNamespaces.join(', ')} (RCD uses the record grammar).`,
      };
    }
    return { valid: false, reason: 'matches no allocated identifier grammar' };
  };

  const formatEnterprise = (namespace: string, sequence: number): string => {
    if (!enterpriseNamespaces.includes(namespace)) {
      throw new Error(`formatEnterprise: '${namespace}' is not an allocated namespace`);
    }
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
      throw new Error(`formatEnterprise: sequence ${String(sequence)} outside 0-999999`);
    }
    const padded = String(sequence).padStart(6, '0');
    const id = `${prefix}${namespace}-${padded}-${String(dammCheck(padded))}`;
    // The formatted identifier must satisfy the grammar it was formatted from; a pattern whose
    // tail is not -[0-9]{6}-[0-9] would otherwise produce identifiers it then refuses.
    if (!validate(id).valid) {
      throw new Error(`formatEnterprise: ${id} does not satisfy the registry's own grammar`);
    }
    return id;
  };

  return Object.freeze({ prefix, enterpriseNamespaces, validate, formatEnterprise });
}
