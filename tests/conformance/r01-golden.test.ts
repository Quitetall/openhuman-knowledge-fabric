/**
 * R01 conformance.
 *
 * `tests/conformance/r01-golden/` is the released `1.0.0-draft.1` schema pack, pinned byte
 * for byte. These tests assert that every R01 semantic still holds in whatever the ontology
 * has since become — and that every place it does not is a deliberate, recorded change.
 *
 * The assertion USED to be equality: regenerate the ontology, get the pack back. That was
 * right while the ontology was exactly R01, and wrong the moment it had to grow. An equality
 * check makes extension impossible, and an impossible check gets weakened under pressure —
 * which is how a conformance suite quietly stops meaning anything.
 *
 * So the guarantee is now two-sided and strictly stronger where it matters:
 *
 *   PRESERVATION  every R01 type, edge, action and definition still exists, byte-identical.
 *                 An approved semantic cannot be redefined by an extension, ever.
 *   DECLARATION   every addition is named in DECLARED_ADDITIONS below. A new type appearing
 *                 without being declared fails, so growth is recorded rather than absorbed.
 *
 * Without both, the ontology could quietly redefine approved semantics and nothing would
 * notice until a record failed to validate years later.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
 * READ THIS BEFORE CONCLUDING THE BASELINE WAS EDITED. The golden files under
 * `r01-golden/` are NEVER patched — they are the pack as released, and the first test below
 * proves it by checking them against the SHA-256 manifest shipped inside the zip. The
 * divergence lives entirely in the compiler's OUTPUT. So the golden state machines still
 * contain the four contradictions; the compiled ones do not.
 *
 * Consequently this list is a fixed, enumerated set of known corrections, not a tolerance
 * window: it is asserted EXHAUSTIVE, and any new difference — in either direction — fails.
 */
const RECORDED_DIVERGENCES = [
  {
    id: 'GATE-6-EXTENSION',
    path: '.schema_version',
    summary: 'extended to 1.1.0-draft.1 by the Gate 6 configuration and quality types',
  },
  {
    id: 'GATE-6-EXTENSION',
    // The schema's own identity URL carries its version, so it moves with it. Listed
    // separately rather than folded in, because "$id changed" and "the version changed" are
    // different claims and only one of them is harmless on its own.
    path: '.$id',
    summary: 'the schema $id embeds the pack version, which the extension moved',
  },
  {
    id: 'GATE-6-EXTENSION',
    // The same fact, at the path the JSON Schema expresses it: the state-machine artifact
    // carries a bare `schema_version`, the schema carries a const the records must match.
    path: '.properties.schema_version.const',
    summary: 'the version every record must declare, moved by the extension',
  },
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

/** The current pack version, read from the ontology rather than repeated here. */
const currentVersion = (): string =>
  (
    (built('json-schema/knowledge-fabric.schema.json') as Record<string, Json>)[
      'properties'
    ] as Record<string, { const: string }>
  )['schema_version']!.const;

/** Rewrite every `schema_version` in a graph instance, and nothing else. */
function restamp(value: Json): Json {
  const version = currentVersion();
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(
        Object.entries(v as Record<string, Json>).map(([k, x]) =>
          k === 'schema_version' ? [k, version] : [k, walk(x)],
        ),
      );
    }
    return v;
  };
  return walk(structuredClone(value));
}

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

/**
 * Everything schema_version 1.1.0-draft.1 adds to the R01 pack.
 *
 * Asserted EXHAUSTIVE in both directions. A type that appears without being listed here
 * fails, and a type listed here that does not appear fails too — so the ontology cannot grow
 * quietly and this list cannot rot into a description of something that stopped being true.
 */
const DECLARED_ADDITIONS = {
  node_types: [
    'capa',
    'complaint',
    'configuration_item',
    'controlled_document',
    'equipment',
    'interface_contract',
    'milestone',
    'nonconformity',
    'physical_binding',
    'risk_control',
    'supplier',
    'test_definition',
    'test_execution',
    'work_order_amendment',
  ],
  edge_types: [
    'bound_to',
    'calibrated_with',
    'conforms_to',
    'raised_against',
    'remediated_by',
    'supplied_by',
  ],
  action_types: [
    'add_controlled_document',
    'approve_capa_plan',
    'approve_controlled_document',
    'approve_test_definition',
    'check_capa_effectiveness',
    'close_capa',
    'close_complaint',
    'close_nonconformity',
    'contain_nonconformity',
    'define_test',
    'deprecate_interface_contract',
    'disposition_nonconformity',
    'disqualify_supplier',
    'execute_test',
    'implement_capa',
    'implement_risk_control',
    'invalidate_test_execution',
    'investigate_complaint',
    'investigate_nonconformity',
    'make_document_effective',
    'open_capa',
    'place_equipment_in_service',
    'plan_test_execution',
    'promote_configuration_item',
    'propose_risk_control',
    'publish_interface_contract',
    'qualify_supplier',
    'quarantine_equipment',
    'raise_nonconformity',
    'receive_complaint',
    'record_physical_binding',
    'record_test_result',
    'register_equipment',
    'register_supplier',
    'remove_equipment_from_service',
    'remove_physical_binding',
    'restrict_supplier',
    'retire_configuration_item',
    'retire_equipment',
    'retire_risk_control',
    'submit_document_for_review',
    'supersede_configuration_item',
    'supersede_controlled_document',
    'supersede_test_definition',
    'triage_complaint',
    'verify_risk_control',
    'withdraw_controlled_document',
    'withdraw_interface_contract',
  ],
} as const;

/**
 * The only constraints an extension is allowed to WIDEN, named one by one.
 *
 * `Edge.edge_type` and `Action.action_type` are closed enumerations over the vocabulary, so
 * adding an edge or action type necessarily grows them. That is a widening, not a
 * redefinition — but it is still checked: the assertion below proves the new enum is a strict
 * SUPERSET, so no R01 token can be dropped while a new one is added.
 *
 * Anything not on this list must be byte-identical.
 */
const WIDENABLE_ENUMS = [
  { def: 'Edge', path: ['properties', 'edge_type', 'enum'] },
  { def: 'Action', path: ['properties', 'action_type', 'enum'] },
] as const;

/** The version stamp moves with the pack; every definition carries a copy of it. */
const VERSION_CONST = '.properties.schema_version.const';

describe('the extended ontology preserves R01 exactly', () => {
  it('every R01 node, edge and action survives byte-identically', () => {
    // PRESERVATION. An approved semantic may be extended around but never redefined: if a
    // field, pattern, bound or enum value changed under an R01 type, this is where a record
    // written years ago stops validating, and this is where that shows up instead.
    const g = stripProvenance(golden('knowledge-fabric.vocabulary.json')) as Record<
      string,
      Record<string, Json>
    >;
    const b = stripProvenance(built('vocabulary/knowledge-fabric.vocabulary.json')) as Record<
      string,
      Record<string, Json>
    >;

    for (const section of ['node_types', 'edge_types', 'action_types'] as const) {
      for (const [id, definition] of Object.entries(g[section]!)) {
        expect(b[section]!, `${section}.${id} was removed`).toHaveProperty(id);
        expect(diff(definition, b[section]![id]), `${section}.${id} was redefined`).toEqual([]);
      }
    }
    // The invariants are a list, not a map: all ten must still be there, in order.
    expect(diff(g['invariants'], b['invariants'])).toEqual([]);
  });

  it('every R01 JSON Schema definition survives byte-identically', () => {
    // The strongest single assertion in this suite: every type, field, pattern, bound,
    // default and required-list survives the round trip through ontology/.
    const g = stripProvenance(golden('knowledge-fabric.schema.json')) as Record<string, Json>;
    const b = stripProvenance(built('json-schema/knowledge-fabric.schema.json')) as Record<
      string,
      Json
    >;

    const gd = g['$defs'] as Record<string, Json>;
    const bd = b['$defs'] as Record<string, Json>;
    for (const [name, definition] of Object.entries(gd)) {
      expect(bd, `$defs.${name} was removed`).toHaveProperty(name);

      const widenable = WIDENABLE_ENUMS.filter((w) => w.def === name).map(
        (w) => `.${w.path.join('.')}`,
      );
      // Every definition carries the pack's version stamp, so that path moves with it.
      const allowed = [...widenable, VERSION_CONST].sort();
      const actual = diff(definition, bd[name]).sort();
      expect(actual, `$defs.${name} was redefined`).toEqual(
        allowed.filter((a) => actual.includes(a)),
      );
      // And nothing outside the allowed set moved.
      expect(
        actual.filter((x) => !allowed.includes(x)),
        `$defs.${name} changed at`,
      ).toEqual([]);
    }

    // A widening must be a strict SUPERSET. Swapping one token for another would otherwise
    // pass as "the enum changed", which is precisely the redefinition this suite exists to
    // catch.
    for (const w of WIDENABLE_ENUMS) {
      const read = (defs: Record<string, Json>): string[] =>
        w.path.reduce<Json>(
          (acc, k) => (acc as Record<string, Json>)[k]!,
          defs[w.def]!,
        ) as string[];
      const before = read(gd);
      const after = new Set(read(bd));
      for (const token of before) {
        expect(after, `${w.def}.${w.path.at(-1)} dropped '${token}'`).toContain(token);
      }
    }

    // Every R01 node type is still admissible in a graph export.
    const refs = (v: Json): string[] =>
      (
        ((v as Record<string, Json>)['nodes'] as Record<string, Json>)['items'] as Record<
          string,
          { $ref: string }[]
        >
      )['oneOf']!.map((r) => r.$ref);
    const built_refs = new Set(refs(b['properties']!));
    for (const ref of refs(g['properties']!)) {
      expect(built_refs, `${ref} is no longer accepted as a node`).toContain(ref);
    }

    // Everything outside $defs and the node list is compared whole, so a changed envelope
    // rule cannot hide behind the per-definition loop above.
    const envelope = (v: Record<string, Json>): Json => {
      const { $defs: _d, properties, ...rest } = v;
      const { nodes: _n, ...otherProperties } = properties as Record<string, Json>;
      return { ...rest, properties: otherProperties };
    };
    // The two paths the JSON Schema expresses the version bump at, and nothing else.
    expect(diff(envelope(g), envelope(b)).sort()).toEqual(
      ['.$id', '.properties.schema_version.const'].sort(),
    );
  });

  it('every addition is declared, and every declaration is real', () => {
    // DECLARATION. Exhaustive in both directions: growth is recorded rather than absorbed,
    // and this list cannot rot into a description of something that stopped being true.
    const g = stripProvenance(golden('knowledge-fabric.vocabulary.json')) as Record<
      string,
      Record<string, Json>
    >;
    const b = stripProvenance(built('vocabulary/knowledge-fabric.vocabulary.json')) as Record<
      string,
      Record<string, Json>
    >;

    for (const section of ['node_types', 'edge_types', 'action_types'] as const) {
      const added = Object.keys(b[section]!)
        .filter((id) => !(id in g[section]!))
        .sort();
      expect(added, `undeclared additions to ${section}`).toEqual([...DECLARED_ADDITIONS[section]]);
    }
  });

  it('R01 state machines differ ONLY at the recorded defect paths', () => {
    const g = stripProvenance(golden('knowledge-fabric.state-machines.json')) as Record<
      string,
      Json
    >;
    const b = stripProvenance(
      built('state-machines/knowledge-fabric.state-machines.json'),
    ) as Record<string, Json>;

    const gm = g['machines'] as Record<string, Json>;
    const bm = b['machines'] as Record<string, Json>;

    // Only the machines R01 defined. The new ones are checked separately, below.
    const shared = Object.fromEntries(Object.keys(gm).map((id) => [id, bm[id]] as const)) as Record<
      string,
      Json
    >;
    const d = diff({ ...g, machines: gm }, { ...b, machines: shared });

    // Every recorded divergence except the two the JSON Schema expresses and this artifact
    // does not: it carries a bare `schema_version`, not an `$id` or a per-record const.
    expect(d.sort()).toEqual(
      [...RECORDED_DIVERGENCES.map((r) => r.path)]
        .filter((p) => p !== '.$id' && p !== '.properties.schema_version.const')
        .sort(),
    );
  });

  it('every new state machine belongs to a declared new type', () => {
    const gm = (
      stripProvenance(golden('knowledge-fabric.state-machines.json')) as Record<
        string,
        Record<string, Json>
      >
    )['machines']!;
    const bm = (
      stripProvenance(built('state-machines/knowledge-fabric.state-machines.json')) as Record<
        string,
        Record<string, Json>
      >
    )['machines']!;

    const added = Object.keys(bm)
      .filter((id) => !(id in gm))
      .sort();
    // A lifecycle for a type nobody declared is a lifecycle nobody reviewed.
    for (const id of added) {
      expect(DECLARED_ADDITIONS.node_types, `machine '${id}' has no declared type`).toContain(id);
    }
  });

  it('records a rationale for every divergence', () => {
    // Across the whole ontology, not one file: the version bump is justified where the
    // version lives, and the defect corrections where the machines live.
    const yaml = readdirSync(join(ROOT, 'ontology'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => readFileSync(join(ROOT, 'ontology', f), 'utf8'))
      .join('\n');
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
    //
    // The ONLY concession to the extension is the version stamp: every record carries a
    // `schema_version` const, so an example written for 1.0.0-draft.1 cannot validate under
    // 1.1.0-draft.1 without restamping. Asserting that this is the only change needed is a
    // stronger statement than skipping the test — it says an R01-era graph is still a valid
    // graph, field for field, under everything added since.
    const ajv = new Ajv2020.default({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(built('json-schema/knowledge-fabric.schema.json') as object);
    const instance = restamp(golden('example-atlas-enclosure-project.json'));

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

  it('needs nothing but the version stamp — no field was added or removed', () => {
    // Proves the restamp above is exactly that, and not a rewrite that quietly satisfies a
    // constraint the example previously failed.
    const original = golden('example-atlas-enclosure-project.json');
    const stamped = restamp(original);
    expect(diff(original, stamped).every((p) => p.endsWith('.schema_version'))).toBe(true);
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

    const nodes = (restamp(instance) as Record<string, unknown>)['nodes'] as Record<
      string,
      unknown
    >[];
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
