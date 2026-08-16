/**
 * Release-package emitter.
 *
 * Spec §5: a conforming release consists of the controlled document plus nine machine-
 * readable files under one signed or approved release manifest. This assembles those nine
 * from the compiled ontology, using the spec's filenames so the result is a drop-in
 * successor to the R01 draft rather than a differently-shaped thing someone has to map.
 *
 * Three files are carried forward from R01 unchanged, because the compiler does not produce
 * them and the defects being corrected do not touch them:
 *
 *   knowledge-fabric.work-control.bpmn      a process model, unaffected by the corrections
 *   example-atlas-enclosure-project.json    the conformance example, still valid
 *   validate_graph.py                       the portable reference validator
 *
 * `validate_graph.py` is carried forward WITH A KNOWN GAP: it implements four of the ten
 * invariants, leaving six enforced only in prose, which §27.1 calls nonconforming. Gate 3
 * closes that by making all ten simultaneously a database constraint, an action
 * precondition and a conformance test. The gap is reported by `packGaps()` rather than
 * quietly shipped.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ontology } from './model.js';
import { buildArtifacts } from './build.js';
import { compareCanonicalText } from '@kf/canonicalization';

export interface PackFile {
  readonly path: string;
  readonly content: string | Buffer;
}

/** Generated artifact path -> the filename spec §5 gives it. */
const RELEASE_NAMES: Record<string, string> = {
  'json-schema/knowledge-fabric.schema.json': 'knowledge-fabric.schema.json',
  'vocabulary/knowledge-fabric.vocabulary.json': 'knowledge-fabric.vocabulary.json',
  'state-machines/knowledge-fabric.state-machines.json': 'knowledge-fabric.state-machines.json',
  'jsonld/knowledge-fabric.context.jsonld': 'knowledge-fabric.context.jsonld',
  'shacl/knowledge-fabric.shacl.ttl': 'knowledge-fabric.shacl.ttl',
};

const CARRIED_FORWARD = [
  'knowledge-fabric.work-control.bpmn',
  'example-atlas-enclosure-project.json',
  'validate_graph.py',
] as const;

/** Known nonconformances that travel with the package, so approval is an informed act. */
export function packGaps(): readonly string[] {
  return [
    'validate_graph.py implements 4 of 10 invariants (KF-FIN-001, KF-FIN-003 partially, ' +
      'plus invoice line totals). The remaining six exist only in prose, which §27.1 calls ' +
      'nonconforming. Gate 3 enforces all ten as database constraints and action preconditions.',
    'Relation types declare no source_types/target_types, so nothing constrains which object ' +
      'types an edge may connect. Tracked as ONT-012; typing lands in Gate 6.',
    'The manifest is unsigned. §5 requires a signed or approved release manifest before the ' +
      'package is normative.',
  ];
}

/**
 * A package handed to an approver has to say what it is without a covering email. R01
 * shipped a README beyond the nine files §5 names; this one records what changed and what
 * is still open, so nobody has to reconstruct that from a diff.
 */
function readme(o: Ontology, version: string): string {
  return [
    '# OpenHuman Knowledge Fabric schema pack',
    '',
    `Version: \`${version}\`  `,
    'Status: **draft for approval** — not normative until this manifest is signed or approved.  ',
    'Supersedes: `1.0.0-draft.1`  ',
    `Ontology source digest: \`${o.sourceDigest}\``,
    '',
    'Machine-readable companion to `OH-DOC-000002-1`. Compiled from a controlled ontology, so',
    'the schema, vocabulary, state machines, JSON-LD context and SHACL shapes cannot disagree',
    'with one another — there is no second place to edit them.',
    '',
    '## What changed since 1.0.0-draft.1',
    '',
    'Four release-blocking defects in the draft state machines, each a lifecycle that could not',
    'be implemented as written. Spec §1.2 makes a prose/machine contradiction release-blocking;',
    "§5.1's consistency gate surfaced these before approval.",
    '',
    '| Id | Defect | Correction |',
    '|---|---|---|',
    '| R01-DEFECT-002 | `initiative_project.parked` reachable, no exit, not terminal | added `parked → triage` |',
    '| R01-DEFECT-003 | `decision_record.accepted` terminal yet `accepted → superseded` defined | removed from terminal |',
    '| R01-DEFECT-004 | `invoice.disputed` reachable, no exit, not terminal | added `→ approved`, `→ void` |',
    '| R01-DEFECT-005 | `payment.reconciled` terminal yet `reconciled → reversed` defined | removed from terminal |',
    '',
    'The JSON Schema and controlled vocabulary are unchanged in meaning from R01 — regeneration',
    'reproduces them with zero differences.',
    '',
    '## Known gaps',
    '',
    'Recorded here and in the manifest so approving this package is an informed act.',
    '',
    ...packGaps().map((g, i) => `${i + 1}. ${g}`),
    '',
    '## Files',
    '',
    'Five are compiled from the ontology; three are carried forward from R01 byte for byte',
    '(the BPMN process model, the conformance example, and the reference validator).',
    '',
    '```sh',
    'python validate_graph.py example-atlas-enclosure-project.json',
    '```',
    '',
    '`manifest.json` carries the SHA-256 of every other file. It does not list itself: a file',
    'cannot contain its own hash, so verifying the manifest is a separate act — signing it.',
    '',
  ].join('\n');
}

export function buildReleasePack(o: Ontology, r01Dir: string, version: string): PackFile[] {
  const generated = new Map(buildArtifacts(o).map((a) => [a.path, a]));
  const files: PackFile[] = [];

  for (const [from, to] of Object.entries(RELEASE_NAMES)) {
    const a = generated.get(from);
    if (a === undefined) throw new Error(`pack: expected generated artifact ${from}`);
    files.push({ path: to, content: a.content });
  }
  for (const name of CARRIED_FORWARD) {
    files.push({ path: name, content: readFileSync(join(r01Dir, name)) });
  }

  files.push({ path: 'README.md', content: readme(o, version) });
  files.sort((a, b) => compareCanonicalText(a.path, b.path));

  // The manifest does NOT list itself: a file cannot contain its own hash. Verifying the
  // manifest is a separate act — signing it.
  const manifest = {
    schema_version: version,
    document: 'OH-DOC-000002-1',
    status: 'draft_for_approval',
    supersedes: '1.0.0-draft.1',
    ontology_source_digest: o.sourceDigest,
    corrects: ['R01-DEFECT-002', 'R01-DEFECT-003', 'R01-DEFECT-004', 'R01-DEFECT-005'],
    known_gaps: packGaps(),
    files: files.map((f) => {
      const bytes = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
      return {
        path: f.path,
        size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  };

  files.push({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  return files;
}
