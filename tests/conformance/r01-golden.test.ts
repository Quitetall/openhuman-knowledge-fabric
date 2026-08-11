/**
 * R01 conformance.
 *
 * `tests/conformance/r01-golden/` is the released `1.0.0-draft.1` schema pack, pinned byte
 * for byte. These tests assert that the ontology compiler still produces that pack — and
 * that every place it does NOT is a deliberate, recorded correction rather than drift.
 *
 * Without this, the ontology could quietly redefine approved semantics and nothing would
 * notice until a record failed to validate years later.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildArtifacts, loadOntology, type Artifact, type Ontology } from '@kf/ontology-compiler';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = join(ROOT, 'tests', 'conformance', 'r01-golden');

/**
 * The complete set of ways the compiled ontology deliberately differs from the R01 draft.
 *
 * Each entry is a defect found by the consistency checker against the draft pack, which is
 * `draft_for_approval` and therefore still correctable. Spec §1.2 makes a contradiction
 * between prose and machine artifacts release-blocking; §5.1's consistency gate exists to
 * surface exactly these before approval.
 *
 * This list is asserted to be EXHAUSTIVE. A new difference fails the test.
 */
const RECORDED_DIVERGENCES = [
  {
    id: 'R01-DEFECT-002',
    path: '.machines.initiative_project.transitions',
    summary: '`parked` is reachable but has no exit and is not terminal',
  },
  {
    id: 'R01-DEFECT-003',
    path: '.machines.decision_record.terminal',
    summary: '`accepted` is listed terminal while accepted -> superseded is defined',
  },
  {
    id: 'R01-DEFECT-004',
    path: '.machines.invoice.transitions',
    summary: '`disputed` is reachable but has no exit and is not terminal',
  },
  {
    id: 'R01-DEFECT-005',
    path: '.machines.payment.terminal',
    summary: '`reconciled` is listed terminal while reconciled -> reversed is defined',
  },
] as const;

type Json = unknown;

/** Provenance is ours, not the pack's; it is not part of the semantic comparison. */
function stripProvenance(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripProvenance);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>)
        .filter(([k]) => k !== 'x-generated-from')
        .map(([k, v]) => [k, stripProvenance(v)]),
    );
  }
  return value;
}

function diff(a: Json, b: Json, path = ''): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [path];
    return a.flatMap((x, i) => diff(x, b[i], `${path}[${i}]`));
  }
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ao = a as Record<string, Json>;
    const bo = b as Record<string, Json>;
    return [...new Set([...Object.keys(ao), ...Object.keys(bo)])]
      .sort()
      .flatMap((k) => (k in ao && k in bo ? diff(ao[k], bo[k], `${path}.${k}`) : [`${path}.${k}`]));
  }
  return a === b ? [] : [path];
}

const golden = (f: string): Json => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8'));

let ontology: Ontology;
let artifacts: Map<string, Artifact>;
const built = (p: string): Json => JSON.parse(artifacts.get(p)!.content);

beforeAll(() => {
  ontology = loadOntology(join(ROOT, 'ontology'));
  artifacts = new Map(buildArtifacts(ontology).map((a) => [a.path, a]));
});

describe('the pinned golden pack is intact', () => {
  it('matches its own manifest, so the baseline itself has not been edited', () => {
    const manifest = golden('manifest.json') as {
      files: { path: string; size_bytes: number; sha256: string }[];
    };
    expect(manifest.files.length).toBe(9);
    for (const f of manifest.files) {
      const bytes = readFileSync(join(GOLDEN, f.path));
      expect(bytes.length, `${f.path} size`).toBe(f.size_bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), `${f.path} sha256`).toBe(f.sha256);
    }
  });
});

describe('regeneration reproduces the R01 pack', () => {
  it('vocabulary is identical', () => {
    const d = diff(
      stripProvenance(golden('knowledge-fabric.vocabulary.json')),
      stripProvenance(built('vocabulary/knowledge-fabric.vocabulary.json')),
    );
    expect(d).toEqual([]);
  });

  it('JSON Schema is identical', () => {
    // The strongest single assertion in this suite: every type, field, pattern, bound,
    // default and required-list survives the round trip through ontology/.
    const d = diff(
      stripProvenance(golden('knowledge-fabric.schema.json')),
      stripProvenance(built('json-schema/knowledge-fabric.schema.json')),
    );
    expect(d).toEqual([]);
  });

  it('state machines differ ONLY at the recorded defect paths', () => {
    const d = diff(
      stripProvenance(golden('knowledge-fabric.state-machines.json')),
      stripProvenance(built('state-machines/knowledge-fabric.state-machines.json')),
    );
    expect(d.sort()).toEqual([...RECORDED_DIVERGENCES.map((r) => r.path)].sort());
  });

  it('records a rationale for every divergence', () => {
    const yaml = readFileSync(join(ROOT, 'ontology', 'state-machines.yaml'), 'utf8');
    for (const d of RECORDED_DIVERGENCES) {
      // The defect id must appear at the point of change, so a reader hitting the odd-looking
      // line finds out why without leaving the file.
      expect(yaml, `${d.id} (${d.summary}) must be justified in ontology/`).toContain(d.id);
    }
  });
});

describe('the worked example still validates', () => {
  it('atlas enclosure project validates against the REGENERATED schema, zero errors', () => {
    // Spec §30.3 acceptance criterion. The example was authored against the original pack,
    // so if the compiler weakened or altered any constraint this is where it shows.
    const ajv = new Ajv2020.default({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(built('json-schema/knowledge-fabric.schema.json') as object);
    const instance = golden('example-atlas-enclosure-project.json');

    const ok = validate(instance);
    expect(
      validate.errors?.map((e) => `${e.instancePath} ${e.message}`) ?? [],
      'validation errors',
    ).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the example is still the size the pack says it is', () => {
    const inst = golden('example-atlas-enclosure-project.json') as {
      nodes: unknown[];
      edges: unknown[];
      actions: unknown[];
    };
    expect(inst.nodes).toHaveLength(19);
    expect(inst.edges).toHaveLength(17);
    expect(inst.actions).toHaveLength(1);
  });

  it('rejects an instance that violates a regenerated constraint', () => {
    // A schema that accepts everything would pass the test above too. Prove it discriminates.
    const ajv = new Ajv2020.default({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(built('json-schema/knowledge-fabric.schema.json') as object);
    const instance = structuredClone(golden('example-atlas-enclosure-project.json')) as Record<
      string,
      unknown
    >;

    const nodes = instance['nodes'] as Record<string, unknown>[];
    // A v4 UUID where the envelope demands v7 — the exact substitution the pinned pattern exists
    // to prevent, since a v4 id destroys the time ordering the index relies on.
    nodes[0]!['node_id'] = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(validate(instance)).toBe(false);
  });
});

describe('determinism', () => {
  it('two builds of the same ontology are byte identical', () => {
    // If this fails, the drift check in CI is worthless: every build would report changes.
    const a = buildArtifacts(ontology);
    const b = buildArtifacts(loadOntology(join(ROOT, 'ontology')));
    expect(a.map((x) => x.path)).toEqual(b.map((x) => x.path));
    for (const [i, art] of a.entries()) {
      expect(art.content, `${art.path} is not deterministic`).toBe(b[i]!.content);
    }
  });

  it('the source digest changes when a declaration changes', () => {
    const mutated: Ontology = {
      ...ontology,
      rules: ontology.rules.map((r, i) => (i === 0 ? { ...r, severity: 'warning' as const } : r)),
    };
    // Recomputed the same way loadOntology does, minus the digest field itself.
    const { sourceDigest: _drop, ...rest } = mutated;
    const recomputed = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    expect(recomputed).not.toBe(ontology.sourceDigest);
  });

  it('carries provenance on every generated artifact', () => {
    for (const a of artifacts.values()) {
      expect(a.content, `${a.path} has no source digest`).toContain(ontology.sourceDigest);
    }
  });

  it('embeds no wall-clock timestamp, which would break the drift check', () => {
    for (const a of artifacts.values()) {
      expect(a.content, `${a.path} looks like it embeds a build time`).not.toMatch(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    }
  });
});
