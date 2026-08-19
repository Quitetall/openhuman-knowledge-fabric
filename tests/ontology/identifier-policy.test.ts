/**
 * Identifier policy — OH-DOC-000001-3 R01.
 *
 * These tests cover the two things `registry-check` cannot: that the validator REJECTS, and
 * that it rejects for the right reason. A check-digit implementation that returns `true` for
 * everything passes every consistency check in the pack builder — the vectors would still
 * "reproduce", the table would still be a quasigroup — and would be worthless.
 *
 * The negative cases matter more than the positive ones here. A validator nobody has watched
 * refuse anything is an assumption, and this repository has shipped two guards that passed
 * against the case they were written for and were blind to the case that mattered.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAMM_TABLE,
  ENTERPRISE_NAMESPACES,
  dammCheck,
  formatEnterpriseId,
  isAntiSymmetricQuasigroup,
  loadRegistryPolicy,
  validateIdentifier,
} from '@kf/ontology-compiler';

// The policy is read through the compiler's own loader rather than by parsing the YAML here.
// `.npmrc` uses an isolated layout — a package may import only what it declares — and `yaml`
// is the compiler's dependency, not the workspace root's. Going through `loadRegistryPolicy`
// also means these tests exercise the same parse the pack builder uses, so a loader that
// silently dropped a section could not pass here while failing there.
const POLICY = loadRegistryPolicy(join(import.meta.dirname, '..', '..', 'ontology-registry'));

describe('the Damm table', () => {
  it('is an anti-symmetric quasigroup', () => {
    // This is the whole basis of the check-digit property. Without it the table still maps
    // digits to digits and still "works" in the sense of producing an answer.
    expect(isAntiSymmetricQuasigroup(DAMM_TABLE)).toBe(true);
  });

  it('detects every single-digit error in a six-digit sequence', () => {
    // Exhaustive over the claim, not a sample: for a spread of sequences, changing any one
    // digit to any other value must change the check digit.
    for (const seq of ['000000', '000001', '123456', '999999', '024680']) {
      const expected = dammCheck(seq);
      for (let pos = 0; pos < seq.length; pos += 1) {
        for (let d = 0; d <= 9; d += 1) {
          if (String(d) === seq[pos]) continue;
          const mutated = `${seq.slice(0, pos)}${d}${seq.slice(pos + 1)}`;
          expect(dammCheck(mutated), `${seq} -> ${mutated}`).not.toBe(expected);
        }
      }
    }
  });

  it('detects every adjacent transposition', () => {
    for (const seq of ['012345', '102030', '987654', '000012']) {
      const expected = dammCheck(seq);
      for (let i = 0; i < seq.length - 1; i += 1) {
        if (seq[i] === seq[i + 1]) continue; // swapping equal digits is not a transposition
        const swapped = `${seq.slice(0, i)}${seq[i + 1]}${seq[i]}${seq.slice(i + 2)}`;
        expect(dammCheck(swapped), `${seq} -> ${swapped}`).not.toBe(expected);
      }
    }
  });

  it('refuses a non-digit rather than coercing it', () => {
    // Number('x') is NaN, and NaN as a table index is undefined — which would produce a wrong
    // digit silently instead of an error.
    expect(() => dammCheck('00A001')).toThrow(/non-digit/);
  });
});

describe('validateIdentifier', () => {
  it('accepts the two identifiers this organisation has issued', () => {
    expect(validateIdentifier('OH-DOC-000001-3')).toMatchObject({
      valid: true,
      kind: 'enterprise',
    });
    expect(validateIdentifier('OH-DOC-000002-1')).toMatchObject({
      valid: true,
      kind: 'enterprise',
    });
  });

  it('accepts every example the registry declares valid', () => {
    const grammars = POLICY.grammars['grammars'] as Record<string, { examples?: string[] }>;
    for (const name of ['enterprise', 'record', 'serial'] as const) {
      for (const example of grammars[name]?.examples ?? []) {
        expect(validateIdentifier(example), example).toMatchObject({ valid: true });
      }
    }
  });

  it('rejects a wrong check digit and says what was expected', () => {
    const verdict = validateIdentifier('OH-DOC-000001-4');
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/check digit is 4, expected 3/);
  });

  it('rejects an unallocated namespace and names it', () => {
    // §8: an identifier that does not appear in the registry does not exist. The shape is
    // right, so the message has to say which half was wrong or the reader will not see it.
    const verdict = validateIdentifier('OH-XYZ-000001-3');
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/'XYZ' is not an allocated namespace/);
  });

  it('rejects OH-RCD under the enterprise grammar and accepts it under the record grammar', () => {
    // RCD is a namespace (§4.2) whose members use the record grammar (§9.4). Both halves of
    // that are easy to get wrong in opposite directions.
    expect(validateIdentifier('OH-RCD-000001-3').valid).toBe(false);
    expect(validateIdentifier('OH-RCD-2026-000001-5')).toMatchObject({
      valid: true,
      kind: 'record',
    });
  });

  it('computes the record check digit over the year AND the sequence', () => {
    // The digit covers YYYYNNNNNN — ten digits. Computing it over the six-digit sequence alone
    // is the obvious mistake, and it would still produce a plausible-looking identifier.
    expect(dammCheck('2026000001')).toBe(5);
    expect(dammCheck('000001')).toBe(3);
    expect(validateIdentifier('OH-RCD-2026-000001-3').valid).toBe(false);
  });

  it('rejects lowercase, whitespace and revision-suffixed forms', () => {
    for (const bad of [
      'oh-doc-000001-3',
      ' OH-DOC-000001-3',
      'OH-DOC-000001-3 ',
      'OH-DOC-000001-3-R01', // filename form, not an identifier
      'OH-DOC-00001-3', // five digits, not six
      'OH-DOC-0000001-3', // seven
    ]) {
      expect(validateIdentifier(bad).valid, bad).toBe(false);
    }
  });

  it('rejects the negative vectors the registry ships', () => {
    const vectors = POLICY.damm['reject_vectors'] as { identifier: string }[];
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      expect(validateIdentifier(v.identifier), v.identifier).toMatchObject({ valid: false });
    }
  });
});

describe('formatEnterpriseId', () => {
  it('round-trips through validateIdentifier for the whole sequence space it will use', () => {
    // Not exhaustive over 10^6 — a spread including both boundaries and the two real ones.
    for (const n of [0, 1, 2, 7, 42, 123, 999, 1000, 65535, 999_999]) {
      const id = formatEnterpriseId('DOC', n);
      expect(validateIdentifier(id), id).toMatchObject({ valid: true });
    }
  });

  it('reproduces the identifiers already issued', () => {
    expect(formatEnterpriseId('DOC', 1)).toBe('OH-DOC-000001-3');
    expect(formatEnterpriseId('DOC', 2)).toBe('OH-DOC-000002-1');
    expect(formatEnterpriseId('ITM', 123)).toBe('OH-ITM-000123-4');
  });

  it('refuses an unallocated namespace and an out-of-range sequence', () => {
    expect(() => formatEnterpriseId('XYZ', 1)).toThrow(/not an allocated namespace/);
    expect(() => formatEnterpriseId('RCD', 1)).toThrow(/not an allocated namespace/);
    expect(() => formatEnterpriseId('DOC', 1_000_000)).toThrow(/outside 0-999999/);
    expect(() => formatEnterpriseId('DOC', -1)).toThrow(/outside 0-999999/);
  });
});

describe('the namespace list', () => {
  it('matches ontology-registry/namespaces.yaml', () => {
    // damm.ts carries the list as a constant so it needs no filesystem at runtime. That copy
    // is only safe while something compares it to the source.
    const declared = (POLICY.namespaces['namespaces'] as { code: string; grammar: string }[])
      .filter((n) => n.grammar === 'enterprise')
      .map((n) => n.code);
    expect([...ENTERPRISE_NAMESPACES].sort()).toEqual([...declared].sort());
  });

  it('has 19 enterprise namespaces and excludes RCD', () => {
    expect(ENTERPRISE_NAMESPACES).toHaveLength(19);
    expect(ENTERPRISE_NAMESPACES).not.toContain('RCD');
  });
});
