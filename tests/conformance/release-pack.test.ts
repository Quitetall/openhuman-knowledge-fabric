/**
 * Release package assembly.
 *
 * The pack is a §5 deliverable and the thing a reviewer would actually approve, so its
 * shape has to be checked rather than eyeballed once. `release/` is gitignored — the
 * package is build output, and a committed copy could drift from the ontology that made it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReleasePack, loadOntology, packGaps, type PackFile } from '@kf/ontology-compiler';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = join(ROOT, 'tests', 'conformance', 'r01-golden');

const ontology = loadOntology(join(ROOT, 'ontology'));
const pack = buildReleasePack(ontology, GOLDEN, '1.0.0-draft.2');
const byPath = new Map(pack.map((f) => [f.path, f]));
const bytes = (f: PackFile): Buffer =>
  Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');

/**
 * The nine filenames spec §5 names, plus the README the R01 pack shipped alongside them.
 * A package handed to an approver should describe itself, so the README is generated here
 * too rather than dropped.
 */
const REQUIRED = [
  'README.md',
  'knowledge-fabric.schema.json',
  'knowledge-fabric.vocabulary.json',
  'knowledge-fabric.state-machines.json',
  'knowledge-fabric.context.jsonld',
  'knowledge-fabric.shacl.ttl',
  'knowledge-fabric.work-control.bpmn',
  'validate_graph.py',
  'example-atlas-enclosure-project.json',
  'manifest.json',
];

describe('package shape', () => {
  it('contains exactly the files a conforming release carries', () => {
    expect([...byPath.keys()].sort()).toEqual([...REQUIRED].sort());
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(String(byPath.get('manifest.json')!.content)) as {
    schema_version: string;
    supersedes: string;
    status: string;
    corrects: string[];
    known_gaps: string[];
    ontology_source_digest: string;
    files: { path: string; size_bytes: number; sha256: string }[];
  };

  it('hashes every file correctly', () => {
    for (const entry of manifest.files) {
      const f = byPath.get(entry.path)!;
      expect(bytes(f).length, `${entry.path} size`).toBe(entry.size_bytes);
      expect(createHash('sha256').update(bytes(f)).digest('hex'), `${entry.path}`).toBe(
        entry.sha256,
      );
    }
  });

  it('does not list itself — a file cannot contain its own hash', () => {
    expect(manifest.files.map((f) => f.path)).not.toContain('manifest.json');
    expect(manifest.files).toHaveLength(REQUIRED.length - 1);
  });

  it('matches R01 file for file, so it drops in where R01 sat', () => {
    const r01 = JSON.parse(readFileSync(join(GOLDEN, 'manifest.json'), 'utf8')) as {
      files: { path: string }[];
    };
    expect(manifest.files.map((f) => f.path).sort()).toEqual(r01.files.map((f) => f.path).sort());
  });

  it('records what it supersedes and what it corrects', () => {
    expect(manifest.supersedes).toBe('1.0.0-draft.1');
    expect(manifest.corrects).toEqual([
      'R01-DEFECT-002',
      'R01-DEFECT-003',
      'R01-DEFECT-004',
      'R01-DEFECT-005',
    ]);
  });

  it('binds the package to the ontology that produced it', () => {
    expect(manifest.ontology_source_digest).toBe(ontology.sourceDigest);
  });

  it('still declares itself draft, because nothing here signs it', () => {
    // §5 requires a signed or approved manifest before the package is normative. Emitting
    // one does not approve it, and the status must not imply otherwise.
    expect(manifest.status).toBe('draft_for_approval');
  });

  it('carries its known gaps, so approving it is an informed act', () => {
    expect(manifest.known_gaps).toEqual([...packGaps()]);
    expect(manifest.known_gaps.length).toBeGreaterThan(0);
    expect(manifest.known_gaps.join(' ')).toContain('unsigned');
  });
});

describe('contents', () => {
  it('regenerates the five compiled files from the ontology', () => {
    for (const name of [
      'knowledge-fabric.schema.json',
      'knowledge-fabric.vocabulary.json',
      'knowledge-fabric.state-machines.json',
      'knowledge-fabric.context.jsonld',
      'knowledge-fabric.shacl.ttl',
    ]) {
      expect(String(byPath.get(name)!.content), `${name} provenance`).toContain(
        ontology.sourceDigest,
      );
    }
  });

  it('describes itself, including what is still open', () => {
    const readme = String(byPath.get('README.md')!.content);
    for (const id of ['R01-DEFECT-002', 'R01-DEFECT-003', 'R01-DEFECT-004', 'R01-DEFECT-005']) {
      expect(readme, id).toContain(id);
    }
    expect(readme).toContain('not normative until');
    expect(readme).toContain(ontology.sourceDigest);
  });

  it('carries the other three forward from R01 byte for byte', () => {
    for (const name of [
      'knowledge-fabric.work-control.bpmn',
      'example-atlas-enclosure-project.json',
      'validate_graph.py',
    ]) {
      expect(bytes(byPath.get(name)!).equals(readFileSync(join(GOLDEN, name))), name).toBe(true);
    }
  });

  it('actually corrects the state machines it claims to', () => {
    const sm = JSON.parse(String(byPath.get('knowledge-fabric.state-machines.json')!.content)) as {
      machines: Record<string, { terminal: string[]; transitions: [string, string, string][] }>;
    };
    const leaves = (id: string): [string, string, string][] =>
      sm.machines[id]!.transitions.filter((t) => sm.machines[id]!.terminal.includes(t[0]));
    const deadEnds = (id: string): string[] => {
      const m = sm.machines[id]!;
      const reachable = new Set<string>();
      const from = new Set(m.transitions.map((t) => t[0]));
      // Collect every state the machine can be in.
      for (const [a, b] of m.transitions) {
        reachable.add(a);
        reachable.add(b);
      }
      return [...reachable].filter((s) => !m.terminal.includes(s) && !from.has(s));
    };

    for (const id of Object.keys(sm.machines)) {
      expect(leaves(id), `${id} leaves a terminal state`).toEqual([]);
      expect(deadEnds(id), `${id} has a dead end`).toEqual([]);
    }
  });

  it('leaves the R01 baseline still exhibiting the defects — it is never patched', () => {
    // If this ever passes-by-being-clean, someone edited the golden and the whole
    // conformance argument collapses.
    const r01 = JSON.parse(
      readFileSync(join(GOLDEN, 'knowledge-fabric.state-machines.json'), 'utf8'),
    ) as {
      machines: Record<string, { terminal: string[]; transitions: [string, string, string][] }>;
    };
    const dec = r01.machines['decision_record']!;
    expect(dec.terminal).toContain('accepted');
    expect(dec.transitions.some((t) => t[0] === 'accepted')).toBe(true);
  });
});
