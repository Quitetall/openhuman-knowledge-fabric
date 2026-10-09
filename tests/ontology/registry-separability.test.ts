/**
 * The product is separable from one deployment's identifier registry — and where it is not, the
 * coupling is recorded here, exhaustively (KF-SAS-RQ-139, SAS §70.2 and §100.3).
 *
 * ADR 0006 said it plainly: "No second registry has ever been compiled. A seam that has held
 * exactly one instance is not demonstrated to be a seam." `fixtures/registry-second/` is that
 * second instance: a different organization (prefix `AC-`, not `OH-`) with a different
 * namespace set (no `LOT`). It is a fixture, not a shipped registry.
 *
 * What this file establishes:
 *
 *   1. The second registry LOADS and PACKS through the same compiler, and its machine-readable
 *      policy files carry nothing of OpenHuman's.
 *   2. The database accepts its identifiers once its namespaces are seeded — proved against a
 *      real database by `tests/database/instance-identifier-namespace.test.ts` ("accepts a
 *      DIFFERENT organisation prefix once allocated — the whole point"), cited, not repeated.
 *   3. Its identifiers validate under its own grammar, compiled from its `grammars.yaml`, and
 *      registry-check's reject-vector gate is not vacuous for it (SAS §100.3).
 *   4. Every place the product still pins `OH-` is listed in RECORDED_COUPLINGS below, and the
 *      list is asserted EXHAUSTIVE in both directions: a new pin fails, and a removed one fails
 *      until the record is updated. That is RQ-139's "where that separation does not yet hold,
 *      the specific coupling SHALL be recorded", made checkable.
 *
 * The `^OH-` pin in `ontology/meta.yaml` is NOT removed here. It is part of the approved, signed
 * R01 pack, and un-pinning it is a governance act for the pack owner (§70.2) — which is why the
 * registry check's refusal of the second registry is asserted as the recorded outcome, not
 * treated as a failure to fix.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRegistryPack,
  checkRegistryPolicy,
  dammCheck,
  identifierGrammar,
  loadRegistryPolicy,
} from '@kf/ontology-compiler';

const ROOT = join(import.meta.dirname, '..', '..');
const SECOND = join(ROOT, 'tests', 'ontology', 'fixtures', 'registry-second');
const FIRST = join(ROOT, 'registries', 'openhuman');

/**
 * Every file in the product that still pins the `OH-` prefix in something executable, with why.
 * Comments and prose do not count; patterns and code do.
 */
const RECORDED_COUPLINGS: Readonly<Record<string, string>> = {
  'ontology/meta.yaml':
    'enterprise_id.any_of_patterns pins ^OH-. Part of the approved R01 pack; un-pinning is a ' +
    'specification amendment for the pack owner (SAS §70.2), refused by r01-golden PRESERVATION.',
  'generated/json-schema/knowledge-fabric.schema.json':
    'compiled from ontology/meta.yaml; inherits the pin, so a graph export carrying AC- ' +
    'identifiers fails schema validation.',
  'generated/openapi/knowledge-fabric.openapi.json': 'compiled from ontology/meta.yaml.',
  // packages/ontology-compiler/src/damm.ts was the fourth: validateIdentifier and
  // formatEnterpriseId hard-coded ^OH- and OpenHuman's namespace list, which made the
  // registry-check reject-vector gate vacuous for a second registry. Removed for SAS §100.3:
  // the validator is now compiled from the registry's grammars.yaml (identifierGrammar).
};

/** Files whose executable lines name the `OH-` prefix as a pattern or literal. */
function pinnedFiles(): string[] {
  const roots = ['ontology', 'generated', 'packages'];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(ROOT, path);
      if (rel.startsWith('packages/') && !/\/src\/.*\.ts$/.test(rel)) continue;
      if (rel.endsWith('.test.ts') || rel.endsWith('.md')) continue;
      const executable = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line));
      if (executable.some((line) => /\^OH-|`\^OH|\/\^OH/.test(line))) out.push(rel);
    }
  };
  for (const root of roots) walk(join(ROOT, root));
  return out.sort();
}

describe('a second registry compiles (KF-SAS-RQ-139)', () => {
  const second = loadRegistryPolicy(SECOND);

  it('is genuinely a different registry, not a renamed copy of the first', () => {
    const first = loadRegistryPolicy(FIRST);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
    const codes = (p: typeof second): string[] =>
      (p.namespaces['namespaces'] as { code: string }[]).map((n) => n.code);
    expect(codes(first)).toContain('LOT');
    expect(codes(second)).not.toContain('LOT');
    const grammar = (second.grammars['grammars'] as Record<string, { pattern: string }>)[
      'enterprise'
    ]!.pattern;
    expect(grammar.startsWith('^AC-')).toBe(true);
  });

  it('packs through the same compiler, and its policy files carry nothing of OpenHuman', () => {
    const files = buildRegistryPack(second, '0.0.0-fixture');
    const policy = files.filter((f) => f.path.endsWith('.json') && f.path !== 'manifest.json');
    expect(policy.length).toBeGreaterThanOrEqual(6);
    for (const file of policy) {
      expect(String(file.content), `${file.path} names OH-`).not.toMatch(/\bOH-/);
    }
  });

  it("is refused by registry-check for exactly one reason: the ontology's pinned prefix", () => {
    const refusals = checkRegistryPolicy(second, join(ROOT, 'ontology')).filter(
      (f) => f.severity === 'error',
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect([...new Set(refusals.map((f) => f.check))]).toEqual([
      'ontology_accepts_every_registry_identifier',
    ]);
    for (const refusal of refusals) expect(refusal.detail).toMatch(/ontology\/meta\.yaml/);
    // The first registry, for contrast, is consistent.
    expect(
      checkRegistryPolicy(loadRegistryPolicy(FIRST), join(ROOT, 'ontology')).filter(
        (f) => f.severity === 'error',
      ),
    ).toEqual([]);
  });

  it("checks a second registry's reject vectors against its own grammar, not OpenHuman's", () => {
    // SAS §100.3: while damm.ts hard-coded ^OH-, every AC- identifier was refused for its
    // prefix before its check digit was read, so this gate passed a reject vector that is in
    // fact a valid identifier. Plant one and require the gate to name it.
    const payload = '000001';
    const valid = `AC-DOC-${payload}-${String(dammCheck(payload))}`;
    const planted = {
      ...second,
      damm: {
        ...second.damm,
        reject_vectors: [
          ...(second.damm['reject_vectors'] as unknown[]),
          { identifier: valid, reason: 'planted: a valid identifier posing as a reject vector' },
        ],
      },
    };
    const named = checkRegistryPolicy(planted, join(ROOT, 'ontology')).filter(
      (f) => f.check === 'damm_reject_vectors',
    );
    expect(named.map((f) => f.detail)).toEqual([
      `${valid} was accepted; it must be rejected (planted: a valid identifier posing as a reject vector)`,
    ]);
  });

  it("validates a second registry's identifiers by its own grammar, and refuses OpenHuman's", () => {
    // Before SAS §100.3 was closed, damm.ts refused AC-ITM-000123-4 for its prefix alone.
    const payload = '000123';
    const check = String(dammCheck(payload));
    const own = identifierGrammar(second.grammars);
    const openhuman = identifierGrammar(loadRegistryPolicy(FIRST).grammars);
    expect(own.prefix).toBe('AC-');
    expect(own.enterpriseNamespaces).not.toContain('LOT');
    expect(own.validate(`AC-ITM-${payload}-${check}`)).toEqual({ valid: true, kind: 'enterprise' });
    expect(own.validate(`OH-ITM-${payload}-${check}`).valid).toBe(false);
    expect(own.validate(`AC-LOT-${payload}-${check}`).reason).toMatch(/'LOT' is not an allocated/);
    expect(own.formatEnterprise('ITM', 123)).toBe(`AC-ITM-${payload}-${check}`);
    expect(openhuman.validate(`OH-ITM-${payload}-${check}`).valid).toBe(true);
    expect(openhuman.validate(`AC-ITM-${payload}-${check}`).valid).toBe(false);
  });
});

describe('every remaining OH- pin is recorded', () => {
  it('lists exactly the files that pin the prefix, in both directions', () => {
    expect(pinnedFiles()).toEqual(Object.keys(RECORDED_COUPLINGS).sort());
  });

  it('gives each recorded coupling a reason', () => {
    for (const [file, reason] of Object.entries(RECORDED_COUPLINGS)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
