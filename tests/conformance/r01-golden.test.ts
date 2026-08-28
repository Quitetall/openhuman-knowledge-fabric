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
 * The four corrections were ACCEPTED by the pack owner on 2026-08-16
 * (`docs/decisions/0001-r01-schema-pack-defects.md`). That does not soften this list: it is
 * still asserted exhaustive, and a new difference in either direction still fails. What
 * changed is only what the list means — differences that were ruled on, rather than
 * differences awaiting a ruling. Signing `1.0.0-draft.2` is a separate act and has not
 * happened; the pack is still non-normative under §1.2.
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
    'authored_fragment',
    'capa',
    'complaint',
    'configuration_item',
    'controlled_document',
    'document_composition',
    'equipment',
    'interface_contract',
    'milestone',
    'ml_promotion_decision',
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
    // Document and ADR relations (ADR 0002). R01 has `supersedes` and `amends`, which say a
    // later record REPLACES or CHANGES an earlier one. Neither describes a record that adds to
    // another while leaving it in force — an ADR whose predecessor still stands. That is
    // `extends`, and it is acyclic for the same reason `supersedes` is: nothing can extend
    // itself through any chain.
    'extends',
    'raised_against',
    'remediated_by',
    'supplied_by',
  ],
  action_types: [
    'accept_document_compilation',
    'add_authored_fragment',
    'add_controlled_document',
    'add_document_composition',
    'append_ml_metric_event',
    'apply_document_proposal',
    'approve_capa_plan',
    'approve_controlled_document',
    'approve_test_definition',
    'authorize_ml_metric_stream',
    'authorize_ml_promotion',
    'change_document_source_holder',
    'check_capa_effectiveness',
    'close_capa',
    'close_complaint',
    'close_nonconformity',
    'compile_master_record',
    'consume_secure_object_capability',
    'contain_nonconformity',
    'define_test',
    'deprecate_interface_contract',
    'disposition_nonconformity',
    'disqualify_supplier',
    'execute_test',
    // Names the act that grants a person a clearance. R01 has no such type, yet
    // `org.person_clearance.granted_by_action` is a NOT NULL foreign key to `core.action` — so
    // the schema requires a recorded act that the vocabulary could not name. The only way to
    // satisfy the constraint was to cite an unrelated type, which is what the test harness does
    // for fixtures and which would be a false statement in a real audit log.
    //
    // Deliberately not dispatchable: dispatch binds authoritative clearance before effects, so
    // the first clearance in an organization cannot be granted by a dispatched action without
    // circularity. It is an owner-credential bootstrap act that still records this type and
    // still extends the audit chain.
    'grant_person_clearance',
    'implement_capa',
    'implement_risk_control',
    'invalidate_test_execution',
    'investigate_complaint',
    'investigate_nonconformity',
    'issue_secure_object_capability',
    'make_document_effective',
    'open_capa',
    'place_equipment_in_service',
    'plan_test_execution',
    'promote_configuration_item',
    'propose_risk_control',
    'publish_document_view',
    'publish_interface_contract',
    'qualify_supplier',
    'quarantine_equipment',
    'raise_nonconformity',
    'receive_complaint',
    'record_document_proposal',
    'record_physical_binding',
    'record_secure_object_erasure',
    'record_test_result',
    'register_equipment',
    // Records that bytes exist somewhere we do NOT hold. R01 has `attach_evidence`, which
    // asserts possession — it writes `source_system='object_store'` and requires a
    // `storage_uri`, so third-party material could only enter by copying it. A vendor
    // datasheet is somebody else's copyright and is referenced by document number, revision
    // and digest instead. Widening `attach_evidence` was rejected: an audit log that uses one
    // verb for "we hold this" and "this exists elsewhere" can no longer answer which is true.
    'register_external_artifact',
    // ML lineage registration (docs/architecture/federated-ml-secure-object-contract.md).
    // Four separate actions rather than one `register_ml_thing` with a kind, because each
    // binds a different tuple and each is audited independently — a run's lineage, a metric's
    // definition, a segment of its series, and a safe aggregate are four claims about
    // different objects, and collapsing them would make one audit entry stand for all four.
    'register_ml_aggregate_reference',
    'register_ml_metric_definition',
    'register_ml_metric_segment',
    'register_ml_run_lineage',
    'register_secure_object_authority_key',
    'register_supplier',
    'release_person_entitlement_exclusion',
    'remove_equipment_from_service',
    'remove_physical_binding',
    'request_document_compilation',
    'request_secure_object_access',
    'request_secure_object_erasure',
    'restrict_supplier',
    'retire_authored_fragment',
    'retire_configuration_item',
    'retire_equipment',
    'retire_risk_control',
    'revise_authored_fragment',
    'revise_document_composition',
    'revoke_secure_object_authority_key',
    'revoke_secure_object_capability',
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

/** New invariants are explicit additions; all pinned R01 invariants remain in exact order. */
const DECLARED_INVARIANT_ADDITIONS = [
  'Every authored document subject has one current Source Holder and Holder changes use the narrow typed action.',
  'A compilation run and its views must consume the exact Basis authorized by one prior compilation request action.',
  'Each document subject has one immutable authoritative document policy that callers cannot weaken; Holder transfer, compilation acceptance and publication require scoped technical authority plus any quality authority required by that policy.',
  'A Proposal Overlay is append-only; applying one requires a human-authorized typed action, an applied fragment remains a live draft, and no result is official before controlled review, effectivity and publication.',
  'Every official document publication has one append-only receipt binding the exact accepted compiler result, effective controlled content revision and registered destination policy that authorized it.',
] as const;

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

// Relevance metadata is an additive contract on pre-existing relation types. It is deliberately
// stripped only for the R01 byte-preservation comparison below; the ontology compiler and its
// registry checks validate the metadata itself, so adding it cannot redefine the pinned edge
// semantics while still letting the compiler read one authoritative policy.
const RELATION_POLICY_FIELDS = new Set(['person_anchor', 'propagation_class', 'anchor_depth']);

function withoutRelationPolicy(value: Json): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, Json>)
      .filter(([key]) => !RELATION_POLICY_FIELDS.has(key))
      .map(([key, nested]) => [key, withoutRelationPolicy(nested)]),
  );
}

/** The version stamp moves with the pack; every definition carries a copy of it. */
const VERSION_CONST = '.properties.schema_version.const';

describe('the extended ontology preserves R01 exactly', () => {
  it('every R01 node, edge and action survives byte-identically', () => {
    // PRESERVATION. An approved semantic may be extended around but never redefined: if a
    // field, pattern, bound or enum value changed under an R01 type, this is where a record
    // written years ago stops validating, and this is where that shows up instead.
    // Typed `Record<string, Json>` — one level, not two. The document is NOT uniformly a map
    // of maps: `invariants` is a list, so the two-level annotation was false for that key,
    // and it is the key the assertions at the bottom of this test read.
    const g = stripProvenance(golden('knowledge-fabric.vocabulary.json')) as Record<string, Json>;
    const b = stripProvenance(built('vocabulary/knowledge-fabric.vocabulary.json')) as Record<
      string,
      Json
    >;

    // Each section is checked to BE a map before it is walked as one. A section that came
    // back missing or the wrong shape would otherwise walk zero entries and pass — a
    // preservation test that silently verifies nothing is the failure this file exists to
    // prevent.
    const sectionOf = (document: Record<string, Json>, name: string): Record<string, Json> => {
      const value = document[name];
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`vocabulary section ${name} is not an object`);
      }
      return value as Record<string, Json>;
    };

    for (const section of ['node_types', 'edge_types', 'action_types'] as const) {
      const goldenSection = sectionOf(g, section);
      const builtSection = sectionOf(b, section);
      expect(
        Object.keys(goldenSection).length,
        `${section} is empty in the golden pack`,
      ).toBeGreaterThan(0);
      for (const [id, definition] of Object.entries(goldenSection)) {
        expect(builtSection, `${section}.${id} was removed`).toHaveProperty(id);
        const before = section === 'edge_types' ? withoutRelationPolicy(definition) : definition;
        const after =
          section === 'edge_types' ? withoutRelationPolicy(builtSection[id]) : builtSection[id];
        expect(diff(before, after), `${section}.${id} was redefined`).toEqual([]);
      }
    }
    // The invariants are a list, not a map: all ten pinned entries remain byte-identical and
    // in order, while every extension invariant is named exhaustively above.
    const additions = new Set<string>(DECLARED_INVARIANT_ADDITIONS);
    const currentInvariants = b['invariants'];
    if (!Array.isArray(currentInvariants)) {
      throw new Error('the built vocabulary carries no invariants list');
    }
    expect(
      diff(
        g['invariants'],
        currentInvariants.filter((item) => !additions.has(String(item))),
      ),
    ).toEqual([]);
    expect(currentInvariants.filter((item) => additions.has(String(item)))).toEqual([
      ...DECLARED_INVARIANT_ADDITIONS,
    ]);
  });

  it('declares relevance policy for every relation type', () => {
    const builtSection = stripProvenance(
      built('vocabulary/knowledge-fabric.vocabulary.json'),
    ) as Record<string, Json>;
    const edges = builtSection['edge_types'];
    if (typeof edges !== 'object' || edges === null || Array.isArray(edges)) {
      throw new Error('built vocabulary carries no edge_types map');
    }
    for (const [id, value] of Object.entries(edges as Record<string, Json>)) {
      expect(value, `${id} has no relation policy`).toMatchObject({
        person_anchor: expect.any(Boolean),
        propagation_class: expect.any(String),
        anchor_depth: expect.any(Number),
      });
    }
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
