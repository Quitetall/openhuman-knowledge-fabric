/**
 * Identifier-policy pack — the machine-readable companion to `OH-DOC-000001-3` R01.
 *
 * §15.3 names "Machine-readable policy and ontology" as a required bootstrap work product, and
 * §12.1 makes the structured data authoritative with the DOCX as "a controlled human-readable
 * representation". This module compiles `ontology-registry/*.yaml` into that structured form
 * and packages it under a manifest the existing approval flow can sign.
 *
 * IT IS A SIBLING OF pack.ts, NOT A GENERALISATION OF IT. `model.ts` and the eight modules
 * under `check/` encode the shape of the Knowledge Fabric ontology — object types, relations,
 * actions, state machines. None of that transfers to identifier policy, which has namespaces,
 * grammars and a check-digit table instead. What is shared is the packaging: per-file SHA-256,
 * a manifest that deliberately does not list itself, canonical ordering, and `approval.ts`
 * untouched. `approve` and `verify` already operate on any package directory, so they need no
 * change to serve this one.
 *
 * EVERY CHECK BELOW IS WRITTEN TO BE ABLE TO FAIL. That is the repository rule, and it is not
 * ceremonial here: the Damm table is a hundred hand-transcribed cells, and a single wrong cell
 * produces a validator that quietly accepts some invalid identifiers and rejects some valid
 * ones with no symptom until an identifier is refused in the field.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { canonicalize, compareCanonicalText, digest } from '@kf/canonicalization';
import { DAMM_TABLE, dammCheck, isAntiSymmetricQuasigroup, validateIdentifier } from './damm.js';
import type { PackFile } from './pack.js';

/** The six canonical sources. Listed so a missing or unexpected file is an error, not a silent skip. */
const SOURCES = [
  'namespaces.yaml',
  'grammars.yaml',
  'damm.yaml',
  'codes.yaml',
  'rules.yaml',
  'lifecycle.yaml',
] as const;

export interface RegistryPolicy {
  readonly namespaces: Record<string, unknown>;
  readonly grammars: Record<string, unknown>;
  readonly damm: Record<string, unknown>;
  readonly codes: Record<string, unknown>;
  readonly rules: Record<string, unknown>;
  readonly lifecycle: Record<string, unknown>;
  /** Digest over the canonicalised sources, so a pack can name exactly what it was built from. */
  readonly sourceDigest: string;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected a list`);
  return value;
}

export function loadRegistryPolicy(dir: string): RegistryPolicy {
  const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.yaml')));
  for (const name of SOURCES) {
    if (!present.has(name)) throw new Error(`ontology-registry: missing ${name}`);
    present.delete(name);
  }
  if (present.size > 0) {
    // An unlisted YAML file is either a source nobody compiles — so its content is not in the
    // pack and not in force — or a stray edit. Both are worth failing on.
    throw new Error(`ontology-registry: unexpected file(s): ${[...present].sort().join(', ')}`);
  }

  const read = (name: string): Record<string, unknown> =>
    asRecord(parse(readFileSync(join(dir, name), 'utf8')) as unknown, name);

  const parsed = {
    namespaces: read('namespaces.yaml'),
    grammars: read('grammars.yaml'),
    damm: read('damm.yaml'),
    codes: read('codes.yaml'),
    rules: read('rules.yaml'),
    lifecycle: read('lifecycle.yaml'),
  };
  return { ...parsed, sourceDigest: digest(parsed) };
}

// ── checks ──────────────────────────────────────────────────────────────────────────────────

export interface CheckFailure {
  readonly check: string;
  readonly detail: string;
  /**
   * `warning` is for something worth saying that this gate has no authority to refuse — an
   * allocation R01 made deliberately, where failing the build would mean the toolchain
   * overruling the registry it implements. Only `error` blocks.
   */
  readonly severity: 'error' | 'warning';
}

/** Levenshtein distance, for §14.1's "alias uniqueness, edit distance and retired-code use". */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prev[j]!;
      prev[j] = next;
    }
  }
  return prev[b.length]!;
}

/**
 * Validate the policy against itself and against `ontology/`.
 *
 * Returns every failure rather than throwing on the first, because when a transcription is
 * wrong it is usually wrong in more than one place and fixing them one build at a time is slow.
 */
export function checkRegistryPolicy(p: RegistryPolicy, ontologyDir: string): CheckFailure[] {
  const out: CheckFailure[] = [];
  const fail = (check: string, detail: string): void => {
    out.push({ check, detail, severity: 'error' });
  };
  const warn = (check: string, detail: string): void => {
    out.push({ check, detail, severity: 'warning' });
  };

  // ── the Damm table ───────────────────────────────────────────────────────────────────────
  const sourceTable = asArray(p.damm['table'], 'damm.yaml table').map((r) =>
    asArray(r, 'damm.yaml table row').map(Number),
  );
  if (canonicalize(sourceTable) !== canonicalize(DAMM_TABLE)) {
    fail(
      'damm_table_matches_source',
      'damm.yaml and packages/ontology-compiler/src/damm.ts disagree. They are a checked copy ' +
        'of one table; if they differ, one of them is wrong and neither can be trusted.',
    );
  }
  if (!isAntiSymmetricQuasigroup(DAMM_TABLE)) {
    fail(
      'damm_table_is_anti_symmetric_quasigroup',
      'rows/columns are not all permutations of 0-9, or the diagonal is not zero. The ' +
        'check-digit property does not hold for this table.',
    );
  }

  for (const kind of ['vectors', 'allocated_vectors'] as const) {
    for (const raw of asArray(p.damm[kind], `damm.yaml ${kind}`)) {
      const v = asRecord(raw, `damm.yaml ${kind} entry`);
      const payload = String(v['payload']);
      const claimed = Number(v['check']);
      const actual = dammCheck(payload);
      if (actual !== claimed) {
        fail(
          `damm_${kind}`,
          `${payload}: document says check digit ${claimed}, table gives ${actual}`,
        );
      }
    }
  }

  // A validator that cannot reject is not a validator. These are known-bad identifiers; if any
  // of them validates, the check digit is not actually being enforced.
  for (const raw of asArray(p.damm['reject_vectors'], 'damm.yaml reject_vectors')) {
    const v = asRecord(raw, 'damm.yaml reject_vectors entry');
    const id = String(v['identifier']);
    if (validateIdentifier(id).valid) {
      fail(
        'damm_reject_vectors',
        `${id} was accepted; it must be rejected (${String(v['reason'])})`,
      );
    }
  }

  // ── namespaces ───────────────────────────────────────────────────────────────────────────
  const namespaces = asArray(p.namespaces['namespaces'], 'namespaces.yaml namespaces').map((raw) =>
    asRecord(raw, 'namespaces.yaml entry'),
  );
  const codes = namespaces.map((n) => String(n['code']));

  const seen = new Set<string>();
  for (const c of codes) {
    if (seen.has(c)) fail('namespace_unique', `${c} appears more than once`);
    seen.add(c);
  }

  // §14.1 requires validators to check "alias uniqueness, edit distance and retired-code use".
  // It says that of aliases; namespaces are the stronger case, because a one-character
  // difference between two namespaces is how OH-ITM-000123-4 and OH-ITN-000123-4 both get
  // typed and both get accepted, pointing at different objects.
  //
  // ATTRIBUTION MATTERS HERE. An earlier version of this check cited "R2", which is a rule of
  // OH-DOC-REG-SYS-001-R2 — the registry R01 disclaims. R01's own R2 is about UUIDv7 conformance
  // and has nothing to do with edit distance. A gate enforcing a dead registry's rules under a
  // live registry's rule numbers is worse than no gate: it is wrong and it looks authoritative.
  for (let i = 0; i < codes.length; i += 1) {
    for (let j = i + 1; j < codes.length; j += 1) {
      if (editDistance(codes[i]!, codes[j]!) < 2) {
        fail('code_edit_distance', `${codes[i]} and ${codes[j]} differ by fewer than 2 characters`);
      }
    }
  }

  // NO TWO NAMESPACES MAY COLLAPSE TO THE SAME STRING WHEN MISREAD.
  //
  // OH-DOC-REG-SYS-001-R2 rule R3 forbade I, O and Q adjacent to a numeric field — Q/0 and I/1
  // are the classic transcription confusions. R01 does not carry that rule anywhere, and §4.2
  // then allocates REQ, whose Q sits directly against the sequence in OH-REQ-000123-4.
  //
  // Dropping it was correct, and structurally so. Under R2 the alphabetic fields were semantic
  // and open-ended, so a misread could land on ANOTHER REAL CODE: SOP -> S0P named a different
  // document and looked entirely valid. Under R01 the namespace is one of nineteen closed
  // values, so a misread lands outside the set and is rejected by name. The closed enumeration
  // does the work the rule used to do, and does it better — R2's rule reduced the chance of a
  // bad read; R01's structure guarantees one is caught.
  //
  // THAT HOLDS ONLY WHILE NO TWO NAMESPACES ARE CONFUSABLE WITH EACH OTHER, so that is checked
  // here rather than assumed. It is the load-bearing precondition for a rule R01 chose not to
  // state, and a precondition nobody checks is an assumption.
  //
  // THE OBVIOUS FORMULATION IS WRONG, AND WAS TRIED FIRST. Comparing every pair to see whether
  // one is a single substitution from the other misses the case that actually matters: REQ and
  // REO are not one substitution apart, but BOTH read as RE0 — Q->0 and O->0 — so a person
  // transcribing either can produce the other. Two codes collide when they FOLD TO THE SAME
  // STRING, not when they are adjacent. Folding to a canonical form and grouping catches both
  // shapes; pairwise adjacency catches only one, and silently passed the REQ/REO probe.
  //
  // The reverse direction needs no check: the sequence field is [0-9]{6}, so a digit misread as
  // a letter (OH-REQ-OOO123-4) fails the grammar outright.
  const FOLD: Record<string, string> = { I: '1', O: '0', Q: '0', S: '5', B: '8' };
  const foldConfusable = (code: string): string => [...code].map((ch) => FOLD[ch] ?? ch).join('');

  const byFolded = new Map<string, string[]>();
  for (const c of codes) {
    const key = foldConfusable(c);
    byFolded.set(key, [...(byFolded.get(key) ?? []), c]);
  }
  for (const [folded, group] of byFolded) {
    if (group.length > 1) {
      fail(
        'namespaces_are_not_confusable',
        `${group.join(' and ')} all read as '${folded}' under I/1, O/0, Q/0, S/5 or B/8 ` +
          'confusion. R01 carries no I/O/Q prohibition; what makes that safe is that a misread ' +
          'lands outside the allocated set. This group breaks that — a misread of one names ' +
          'another and validates.',
      );
    }
  }

  // ── grammars ─────────────────────────────────────────────────────────────────────────────
  const grammars = asRecord(p.grammars['grammars'], 'grammars.yaml grammars');
  for (const [name, raw] of Object.entries(grammars)) {
    const g = asRecord(raw, `grammars.yaml ${name}`);
    const re = new RegExp(String(g['pattern']));
    for (const ex of asArray(g['examples'] ?? [], `grammars.yaml ${name} examples`)) {
      if (!re.test(String(ex))) {
        fail(
          'grammar_examples_round_trip',
          `${name}: '${String(ex)}' does not match its own pattern`,
        );
      }
    }
  }

  // The enterprise pattern must enumerate exactly the namespaces declared to use it. A
  // character-class form would accept a namespace nobody allocated; a stale enumeration would
  // reject one that exists.
  const enterpriseDeclared = namespaces
    .filter((n) => n['grammar'] === 'enterprise')
    .map((n) => String(n['code']))
    .sort();
  const enterprisePattern = String(asRecord(grammars['enterprise'], 'enterprise').pattern ?? '');
  // Extracting the alternation by regex is fragile by nature: rewrite the pattern as a
  // character class or nest a group and this stops matching. It would still FAIL — an empty
  // enumeration never equals nineteen namespaces — but it would fail saying "pattern
  // enumerates []", which sends the reader looking for a missing namespace instead of a
  // changed pattern. Say which it is.
  const alternation = /\(([A-Z|]+)\)/.exec(enterprisePattern)?.[1];
  if (alternation === undefined) {
    fail(
      'enterprise_pattern_enumerates_namespaces',
      'could not find an alphabetic alternation in the enterprise pattern. It must enumerate ' +
        'its namespaces — a character class would accept namespaces nobody allocated, which ' +
        'is what §8 forbids.',
    );
  }
  // `fail` records rather than throws, so execution continues past the check above. The guard
  // is what stops an unparseable pattern producing a SECOND, confusing error about an empty
  // enumeration on top of the accurate one.
  if (
    alternation !== undefined &&
    canonicalize(enterpriseDeclared) !== canonicalize(alternation.split('|').sort())
  ) {
    fail(
      'enterprise_pattern_matches_namespaces',
      `pattern enumerates [${alternation.split('|').sort().join(', ')}] but namespaces.yaml declares ` +
        `[${enterpriseDeclared.join(', ')}] as grammar: enterprise`,
    );
  }

  // ── the two identifiers actually issued ──────────────────────────────────────────────────
  // If either of these ever stops validating, something in the chain is wrong and every
  // identifier this organisation has is suspect.
  for (const [id, what] of [
    ['OH-DOC-000001-3', 'this registry'],
    ['OH-DOC-000002-1', 'Knowledge Fabric OGWCS'],
  ] as const) {
    const verdict = validateIdentifier(id);
    if (!verdict.valid)
      fail('issued_identifiers_validate', `${id} (${what}): ${verdict.reason ?? 'invalid'}`);
  }

  // ── agreement with ontology/meta.yaml ────────────────────────────────────────────────────
  // The two directories are separate authorities (§1.1) but they overlap on identity patterns,
  // and an overlap nobody checks is a divergence waiting to happen.
  const meta = asRecord(
    parse(readFileSync(join(ontologyDir, 'meta.yaml'), 'utf8')) as unknown,
    'meta.yaml',
  );
  const uuidHere = String(asRecord(grammars['uuid'], 'grammars.yaml uuid')['pattern']);
  if (String(meta['uuid_pattern']) !== uuidHere) {
    fail(
      'uuid_pattern_agrees_with_ontology',
      `ontology/meta.yaml uuid_pattern differs from ontology-registry/grammars.yaml uuid.pattern`,
    );
  }

  // COMPATIBILITY, NOT EQUALITY — and the difference is load-bearing.
  //
  // `ontology/meta.yaml` accepts `^OH-(?:[A-Z]{2,5})-[0-9]{6}-[0-9]$`: any two-to-five letter
  // namespace. The registry's enterprise pattern enumerates the nineteen that exist, so it is
  // strictly narrower. The obvious move is to tighten the ontology to match. That would be
  // wrong, for a reason the repository already encodes:
  //
  // The loose pattern is part of the RELEASED `1.0.0-draft.1` R01 pack, pinned byte for byte
  // at tests/conformance/r01-golden/. `r01-golden.test.ts` states the rule — "if a field,
  // pattern, bound or enum value changed under an R01 type, this is where a record written
  // years ago stops validating" — and narrowing a pattern is exactly that. An approved
  // semantic is extended around, never redefined.
  //
  // Nor is the schema the right place. R01 rule R7 says invalid check digits are "rejected at
  // entry and import", and Appendix B.1 says regex conformance "is necessary but not
  // sufficient; validators shall also verify ... Damm digits, namespace state". Namespace
  // membership and the check digit are validator obligations, discharged by
  // `validateIdentifier` and the core.object check constraint. A JSON Schema pattern cannot
  // express a check digit at all, so a schema that looked strict would still be insufficient.
  //
  // So what is checked here is one-way: everything the registry accepts, the ontology must
  // also accept. A future ontology edit that narrowed the pattern would break that and be
  // caught, which is the failure actually worth catching.
  const envelope = asRecord(meta['envelope'], 'meta.yaml envelope');
  const fields = asRecord(envelope['fields'], 'meta.yaml envelope.fields');
  const entField = asRecord(fields['enterprise_id'], 'meta.yaml enterprise_id');
  const entPatterns = asArray(entField['any_of_patterns'], 'meta.yaml any_of_patterns')
    .map(String)
    .map((pattern) => new RegExp(pattern));
  const acceptedByOntology = (id: string): boolean => entPatterns.some((re) => re.test(id));

  for (const grammarName of ['enterprise', 'record', 'serial'] as const) {
    const g = asRecord(grammars[grammarName], `grammars.yaml ${grammarName}`);
    for (const ex of asArray(g['examples'] ?? [], `grammars.yaml ${grammarName} examples`)) {
      const id = String(ex);
      // Serials are instance identity, not object enterprise_id, so the ontology is not
      // expected to accept them. Only enterprise and record identifiers land in that column.
      if (grammarName === 'serial') continue;
      if (!acceptedByOntology(id)) {
        fail(
          'ontology_accepts_every_registry_identifier',
          `ontology/meta.yaml enterprise_id rejects ${id}, which ${grammarName} declares valid`,
        );
      }
    }
  }

  // The converse is recorded rather than enforced: the ontology is deliberately the looser of
  // the two. If it ever became the same or narrower, the note below is what should be revisited.
  const ontologyIsLooser = ['OH-XYZ-000001-3', 'OH-ZZ-000001-3'].some(
    (id) => acceptedByOntology(id) && !validateIdentifier(id).valid,
  );
  if (!ontologyIsLooser) {
    warn(
      'ontology_pattern_no_longer_looser',
      'ontology/meta.yaml enterprise_id now rejects unallocated namespaces that the registry ' +
        'also rejects. That may be a deliberate tightening — if so it is a redefinition of an ' +
        'approved R01 pattern and needs the r01-golden preservation allowlist extended.',
    );
  }

  // ── rules ────────────────────────────────────────────────────────────────────────────────
  const rules = asArray(p.rules['rules'], 'rules.yaml rules').map((r) =>
    asRecord(r, 'rules.yaml entry'),
  );
  const ids = rules.map((r) => String(r['id']));
  const expected = Array.from({ length: 18 }, (_, i) => `R${i + 1}`);
  if (canonicalize(ids) !== canonicalize(expected)) {
    fail('rules_R1_to_R18_present_in_order', `expected R1..R18 in order, got ${ids.join(', ')}`);
  }
  for (const r of rules) {
    if (r['enforced_by'] === undefined) {
      fail('rules_declare_enforcement', `${String(r['id'])} does not say where it is enforced`);
    }
  }

  return out;
}

// ── pack ────────────────────────────────────────────────────────────────────────────────────

/** Known gaps that travel with the package, so approving it is an informed act. */
export function registryPackGaps(): readonly string[] {
  return [
    'R6 requires enterprise sequences to be "atomically allocated". No sequence table or ' +
      'allocation service exists yet; allocation is a reviewed seed file in openhuman-quality. ' +
      'Tracked as R01 §17 Phase 1.',
    'R13 ("a named human reviewer decides whether an acronym creates material confusion") and ' +
      'R14 (no PHI/PII/secrets in identifiers) are not machine-enforceable. R13 is unenforced ' +
      "by the document's own wording; R14 is partially covered by gitleaks, which finds " +
      'credential shapes and cannot recognise PHI.',
    'The §9.4 record grammar embeds the creation year in the identifier, while §10.2 forbids ' +
      'exactly that for lots and work orders with a rationale that applies equally. Raised as ' +
      'an amendment question; no OH-RCD identifiers have been issued.',
    'This package is compiled from a document whose control block reads "Draft for approval / ' +
      'Approval record: Pending". Nothing here is normative until OH-DOC-000001-3 R01 is ' +
      'approved and the §15.2 bootstrap is executed.',
    'R01 does not carry OH-DOC-REG-SYS-001-R2 rule R3, which forbade the letters I, O and Q ' +
      'adjacent to a numeric field, and §4.2 then allocates REQ — whose Q sits directly against ' +
      'the sequence in OH-REQ-000123-4. Q/0 and I/1 are the classic transcription confusions, ' +
      'and the Damm digit detects a misread but cannot prevent one. Reported as a warning by ' +
      'registry-check, since refusing an allocation R01 made deliberately is not this ' +
      "toolchain's call. Raised as an amendment question.",
  ];
}

function registryReadme(p: RegistryPolicy, version: string): string {
  const nsCount = asArray(p.namespaces['namespaces'], 'namespaces').length;
  return [
    '# OpenHuman identifier and configuration policy pack',
    '',
    `Version: \`${version}\`  `,
    'Status: **draft for approval** — not normative until this manifest is signed or approved.  ',
    'Supersedes: nothing. This is the initial controlled issue.  ',
    `Policy source digest: \`${p.sourceDigest}\``,
    '',
    'Machine-readable companion to `OH-DOC-000001-3` R01, the Identifier and Configuration',
    'Registry. §12.1 of that document makes this structured data authoritative and the DOCX a',
    'controlled human-readable representation of it; a discrepancy between the two is a',
    'nonconformance to be corrected, not a choice to be made.',
    '',
    '## What this replaces',
    '',
    'Nothing, formally. R01 is an initial controlled issue that supersedes no approved',
    'predecessor — it states "No prior approved registry exists". In practice it displaces three',
    'unapproved schemes, all of which are recorded as retired in `openhuman-registry.codes.json`',
    'so no code can be revived under a different meaning:',
    '',
    '| Scheme | Fate |',
    '|---|---|',
    '| `OH-DOC-REG-SYS-001` R2 | disclaimed; document types and scopes retired as identifier fields |',
    '| `OH-DOC-LST-SYS-001` R4, R5 | disclaimed; `SPC` additionally forbidden by §5.5 |',
    '| `OHT-<TYPE>-<SCOPE>-<NNNN>` | retired 2026-08-04, before either of the above |',
    '',
    '## Known gaps',
    '',
    ...registryPackGaps().map((g, i) => `${i + 1}. ${g}`),
    '',
    '## Files',
    '',
    `Six compiled artifacts covering ${nsCount} namespaces, six identifier grammars, the Damm`,
    'table with its vectors, the semantic-code tables, rules R1–R18 with their enforcement',
    'points, and the identity lifecycles.',
    '',
    '`manifest.json` carries the SHA-256 of every other file. It does not list itself: a file',
    'cannot contain its own hash, so verifying the manifest is a separate act — signing it.',
    '',
    '```sh',
    'pnpm ontology:verify release/openhuman-registry-<version> \\',
    '  --key ontology/release-keys/release-1.pub',
    '```',
    '',
  ].join('\n');
}

const ARTIFACTS: Record<string, keyof RegistryPolicy> = {
  'openhuman-registry.namespaces.json': 'namespaces',
  'openhuman-registry.grammars.json': 'grammars',
  'openhuman-registry.damm.json': 'damm',
  'openhuman-registry.codes.json': 'codes',
  'openhuman-registry.rules.json': 'rules',
  'openhuman-registry.lifecycle.json': 'lifecycle',
};

export function buildRegistryPack(p: RegistryPolicy, version: string): PackFile[] {
  const files: PackFile[] = Object.entries(ARTIFACTS).map(([path, key]) => ({
    path,
    // Canonical serialisation, so the same policy always produces the same bytes and therefore
    // the same digest. A pack whose hash changed on rebuild could not be verified.
    content: `${canonicalize(p[key])}\n`,
  }));

  files.push({ path: 'README.md', content: registryReadme(p, version) });
  files.sort((a, b) => compareCanonicalText(a.path, b.path));

  const manifest = {
    schema_version: version,
    document: 'OH-DOC-000001-3',
    document_revision: 'R01',
    status: 'draft_for_approval',
    supersedes: null,
    policy_source_digest: p.sourceDigest,
    known_gaps: registryPackGaps(),
    files: files.map((f) => {
      const bytes = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
      return {
        path: f.path,
        size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  };
  files.push({ path: 'manifest.json', content: `${canonicalize(manifest)}\n` });
  return files;
}
