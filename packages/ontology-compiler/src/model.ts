/**
 * The ontology model and its loader.
 *
 * `ontology/*.yaml` is canonical. This module turns it into a typed in-memory model that
 * every emitter reads. Nothing else in the system may parse the YAML directly, so there is
 * exactly one interpretation of what the ontology says.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { digest } from '@kf/canonicalization';

// ── field types ─────────────────────────────────────────────────────────────────────────

/** Scalar and reference kinds a field may take. `array<T>` wraps any of them. */
export type FieldKind =
  | 'string'
  | 'uuid'
  | 'timestamp'
  | 'date'
  | 'uri'
  | 'email'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'json'
  | 'object'
  | 'Money'
  | 'ExternalReference'
  | 'EvidenceReference';

export interface Field {
  readonly name: string;
  /** Raw declared type, e.g. `uuid` or `array<Money>`. */
  readonly type: string;
  readonly required: boolean;
  readonly values?: readonly string[];
  /** Draw the enum from a controlled list in meta.yaml rather than repeating it. */
  readonly valuesFrom?: 'classifications' | 'source_authorities' | 'authority_domains';
  readonly pattern?: string;
  /** Alternatives, when one field admits more than one identifier grammar. */
  readonly anyOfPatterns?: readonly string[];
  readonly properties?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly unique?: boolean;
  readonly itemPattern?: string;
  readonly itemMinLength?: number;
  readonly itemMaxLength?: number;
  readonly propertyNamePattern?: string;
  readonly defaultValue?: unknown;
  readonly constValue?: string;
  /** The field is a constant equal to the ontology's schema_version. */
  readonly constSchemaVersion?: boolean;
  /**
   * Shape of a nested object, or of the objects in an array.
   *
   * A line item is not a first-class object (spec §8) but it is still structured. Carrying
   * its shape here keeps it validated rather than degenerating into an opaque blob.
   */
  readonly itemFields?: readonly Field[];
}

export interface ObjectType {
  readonly id: string;
  readonly title: string;
  readonly authority_domain: string;
  readonly enterprise_namespace: string | null;
  readonly enterprise_namespace_proposed: boolean;
  readonly first_class: boolean;
  readonly state_machine: string | null;
  readonly states: readonly string[];
  readonly fields: readonly Field[];
}

export interface RelationType {
  readonly id: string;
  readonly inverse: string;
  readonly acyclic: boolean;
  readonly symmetric: boolean;
  /**
   * Which object types may sit at each end.
   *
   * Optional only because the R01 pack does not carry edge typing; every relation without
   * it raises ONT-012 so the gap is counted rather than forgotten. Until a relation is
   * typed, nothing stops an edge connecting two objects it has no business connecting.
   */
  readonly sourceTypes?: readonly string[];
  readonly targetTypes?: readonly string[];
}

export interface ActionType {
  readonly id: string;
  readonly audited: boolean;
  readonly transactional: boolean;
  /** State machines this action can drive. Empty means it drives no lifecycle. */
  readonly drives: readonly string[];
}

export interface Transition {
  readonly from: string;
  readonly to: string;
  readonly action: string;
}

export interface StateMachine {
  readonly id: string;
  readonly initial: string;
  readonly terminal: readonly string[];
  readonly transitions: readonly Transition[];
}

/** Where a rule is enforced. A rule claiming an implementation that does not exist fails the check. */
export type RuleImplementation = 'database_constraint' | 'action_precondition' | 'validator';

export const RULE_IMPLEMENTATIONS: readonly RuleImplementation[] = [
  'database_constraint',
  'action_precondition',
  'validator',
];

export interface Rule {
  readonly id: string;
  readonly severity: 'error' | 'warning';
  readonly description: string;
  readonly implementation: readonly RuleImplementation[];
}

export interface SharedType {
  readonly name: string;
  readonly fields: readonly Field[];
}

export interface Ontology {
  readonly schemaVersion: string;
  readonly uuidPattern: string;
  readonly classifications: readonly string[];
  readonly sourceAuthorities: readonly string[];
  readonly authorityDomains: readonly string[];
  readonly envelopeRequired: readonly string[];
  readonly envelopeFields: readonly Field[];
  readonly sharedTypes: readonly SharedType[];
  readonly objectTypes: readonly ObjectType[];
  readonly relationTypes: readonly RelationType[];
  readonly actionTypes: readonly ActionType[];
  readonly stateMachines: readonly StateMachine[];
  readonly rules: readonly Rule[];
  /**
   * SHA-256 over the canonicalized ontology. This is the identity of a generated artifact:
   * given the same digest, the compiler produces the same bytes.
   */
  readonly sourceDigest: string;
}

export class OntologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyError';
  }
}

// ── loading ─────────────────────────────────────────────────────────────────────────────

function readYaml(dir: string, file: string): unknown {
  const path = join(dir, file);
  try {
    return parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err: unknown) {
    throw new OntologyError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new OntologyError(`${where}: expected a mapping`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new OntologyError(`${where}: expected a list`);
  return v;
}

function asString(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new OntologyError(`${where}: expected a string`);
  return v;
}

function asStringList(v: unknown, where: string): string[] {
  return asArray(v, where).map((x, i) => asString(x, `${where}[${i}]`));
}

function asNumber(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new OntologyError(`${where}: expected a number`);
  }
  return v;
}

function parseField(raw: unknown, where: string): Field {
  const r = asRecord(raw, where);
  const name = asString(r['name'], `${where}.name`);
  const type = asString(r['type'], `${where}.type`);
  const f: Record<string, unknown> = { name, type, required: r['required'] === true };

  if (r['values'] !== undefined) f['values'] = asStringList(r['values'], `${where}.values`);
  if (r['values_from'] !== undefined) {
    const vf = asString(r['values_from'], `${where}.values_from`);
    if (vf !== 'classifications' && vf !== 'source_authorities' && vf !== 'authority_domains') {
      throw new OntologyError(`${where}.values_from: unknown list '${vf}'`);
    }
    f['valuesFrom'] = vf;
  }
  if (r['pattern'] !== undefined) f['pattern'] = asString(r['pattern'], `${where}.pattern`);
  if (r['any_of_patterns'] !== undefined) {
    f['anyOfPatterns'] = asStringList(r['any_of_patterns'], `${where}.any_of_patterns`);
  }
  if (r['properties'] !== undefined) {
    f['properties'] = asStringList(r['properties'], `${where}.properties`);
  }
  if (r['min_length'] !== undefined)
    f['minLength'] = asNumber(r['min_length'], `${where}.min_length`);
  if (r['max_length'] !== undefined)
    f['maxLength'] = asNumber(r['max_length'], `${where}.max_length`);
  if (r['unique'] !== undefined) f['unique'] = r['unique'] === true;
  if (r['item_pattern'] !== undefined) {
    f['itemPattern'] = asString(r['item_pattern'], `${where}.item_pattern`);
  }
  if (r['item_min_length'] !== undefined) {
    f['itemMinLength'] = asNumber(r['item_min_length'], `${where}.item_min_length`);
  }
  if (r['item_max_length'] !== undefined) {
    f['itemMaxLength'] = asNumber(r['item_max_length'], `${where}.item_max_length`);
  }
  if (r['property_name_pattern'] !== undefined) {
    f['propertyNamePattern'] = asString(
      r['property_name_pattern'],
      `${where}.property_name_pattern`,
    );
  }
  if (r['minimum'] !== undefined) f['minimum'] = asNumber(r['minimum'], `${where}.minimum`);
  if (r['maximum'] !== undefined) f['maximum'] = asNumber(r['maximum'], `${where}.maximum`);
  if (r['min_items'] !== undefined) f['minItems'] = asNumber(r['min_items'], `${where}.min_items`);
  if (r['const'] !== undefined) f['constValue'] = asString(r['const'], `${where}.const`);
  if (r['default'] !== undefined) f['defaultValue'] = r['default'];
  if (r['const_schema_version'] !== undefined) {
    f['constSchemaVersion'] = r['const_schema_version'] === true;
  }
  if (r['item_fields'] !== undefined) {
    f['itemFields'] = asArray(r['item_fields'], `${where}.item_fields`).map((x, i) =>
      parseField(x, `${where}.item_fields[${i}]`),
    );
  }
  return f as unknown as Field;
}

/** Envelope fields are a mapping of name -> spec rather than a list; normalize to Field[]. */
function parseFieldMap(raw: unknown, where: string): Field[] {
  const r = asRecord(raw, where);
  return Object.entries(r).map(([name, spec]) =>
    parseField({ name, ...asRecord(spec, `${where}.${name}`) }, `${where}.${name}`),
  );
}

export function loadOntology(dir: string): Ontology {
  const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.yaml')));
  const expected = [
    'meta.yaml',
    'object-types.yaml',
    'relation-types.yaml',
    'action-types.yaml',
    'state-machines.yaml',
    'rules.yaml',
  ];
  const missing = expected.filter((f) => !present.has(f));
  if (missing.length > 0) {
    throw new OntologyError(`ontology/ is missing: ${missing.join(', ')}`);
  }
  // An unexpected file is an error, not a warning: a definition the compiler silently
  // ignores is a rule that exists in the repository but not in the system.
  const unexpected = [...present].filter((f) => !expected.includes(f));
  if (unexpected.length > 0) {
    throw new OntologyError(
      `ontology/ has files the compiler does not read: ${unexpected.join(', ')}. ` +
        `Add an emitter for them or remove them — a definition nobody compiles is not in force.`,
    );
  }

  const meta = asRecord(readYaml(dir, 'meta.yaml'), 'meta.yaml');
  const envelope = asRecord(meta['envelope'], 'meta.yaml envelope');
  const sharedRaw = asRecord(meta['shared_types'], 'meta.yaml shared_types');

  const objectTypes: ObjectType[] = asArray(
    asRecord(readYaml(dir, 'object-types.yaml'), 'object-types.yaml')['object_types'],
    'object_types',
  ).map((raw, i) => {
    const r = asRecord(raw, `object_types[${i}]`);
    const id = asString(r['id'], `object_types[${i}].id`);
    const ns = r['enterprise_namespace'];
    const sm = r['state_machine'];
    return {
      id,
      title: asString(r['title'], `${id}.title`),
      authority_domain: asString(r['authority_domain'], `${id}.authority_domain`),
      enterprise_namespace: ns === null || ns === undefined ? null : asString(ns, `${id}.ns`),
      enterprise_namespace_proposed: r['enterprise_namespace_proposed'] === true,
      first_class: r['first_class'] === true,
      state_machine: sm === null || sm === undefined ? null : asString(sm, `${id}.state_machine`),
      states: asStringList(r['states'], `${id}.states`),
      fields: asArray(r['fields'] ?? [], `${id}.fields`).map((f, j) =>
        parseField(f, `${id}.fields[${j}]`),
      ),
    };
  });

  const relationTypes: RelationType[] = asArray(
    asRecord(readYaml(dir, 'relation-types.yaml'), 'relation-types.yaml')['relation_types'],
    'relation_types',
  ).map((raw, i) => {
    const r = asRecord(raw, `relation_types[${i}]`);
    const rel: Record<string, unknown> = {
      id: asString(r['id'], `relation_types[${i}].id`),
      inverse: asString(r['inverse'], `relation_types[${i}].inverse`),
      acyclic: r['acyclic'] === true,
      symmetric: r['symmetric'] === true,
    };
    if (r['source_types'] !== undefined) {
      rel['sourceTypes'] = asStringList(r['source_types'], `relation_types[${i}].source_types`);
    }
    if (r['target_types'] !== undefined) {
      rel['targetTypes'] = asStringList(r['target_types'], `relation_types[${i}].target_types`);
    }
    return rel as unknown as RelationType;
  });

  const actionTypes: ActionType[] = asArray(
    asRecord(readYaml(dir, 'action-types.yaml'), 'action-types.yaml')['action_types'],
    'action_types',
  ).map((raw, i) => {
    const r = asRecord(raw, `action_types[${i}]`);
    return {
      id: asString(r['id'], `action_types[${i}].id`),
      audited: r['audited'] === true,
      transactional: r['transactional'] === true,
      drives: asStringList(r['drives'] ?? [], `action_types[${i}].drives`),
    };
  });

  const stateMachines: StateMachine[] = asArray(
    asRecord(readYaml(dir, 'state-machines.yaml'), 'state-machines.yaml')['state_machines'],
    'state_machines',
  ).map((raw, i) => {
    const r = asRecord(raw, `state_machines[${i}]`);
    const id = asString(r['id'], `state_machines[${i}].id`);
    return {
      id,
      initial: asString(r['initial'], `${id}.initial`),
      terminal: asStringList(r['terminal'], `${id}.terminal`),
      transitions: asArray(r['transitions'], `${id}.transitions`).map((t, j) => {
        const tr = asRecord(t, `${id}.transitions[${j}]`);
        return {
          from: asString(tr['from'], `${id}.transitions[${j}].from`),
          to: asString(tr['to'], `${id}.transitions[${j}].to`),
          action: asString(tr['action'], `${id}.transitions[${j}].action`),
        };
      }),
    };
  });

  const rules: Rule[] = asArray(
    asRecord(readYaml(dir, 'rules.yaml'), 'rules.yaml')['rules'],
    'rules',
  ).map((raw, i) => {
    const r = asRecord(raw, `rules[${i}]`);
    const id = asString(r['id'], `rules[${i}].id`);
    const severity = asString(r['severity'], `${id}.severity`);
    if (severity !== 'error' && severity !== 'warning') {
      throw new OntologyError(`${id}.severity must be error or warning, got ${severity}`);
    }
    const impls = asStringList(r['implementation'], `${id}.implementation`);
    for (const impl of impls) {
      if (!(RULE_IMPLEMENTATIONS as readonly string[]).includes(impl)) {
        throw new OntologyError(
          `${id}: unknown implementation ${impl}; expected one of ${RULE_IMPLEMENTATIONS.join(', ')}`,
        );
      }
    }
    return {
      id,
      severity,
      description: asString(r['description'], `${id}.description`),
      implementation: impls as RuleImplementation[],
    };
  });

  const ontology: Omit<Ontology, 'sourceDigest'> = {
    schemaVersion: asString(meta['schema_version'], 'meta.schema_version'),
    uuidPattern: asString(meta['uuid_pattern'], 'meta.uuid_pattern'),
    classifications: asStringList(meta['classifications'], 'meta.classifications'),
    sourceAuthorities: asStringList(meta['source_authorities'], 'meta.source_authorities'),
    authorityDomains: asStringList(meta['authority_domains'], 'meta.authority_domains'),
    envelopeRequired: asStringList(envelope['required'], 'meta.envelope.required'),
    envelopeFields: parseFieldMap(envelope['fields'], 'meta.envelope.fields'),
    sharedTypes: Object.entries(sharedRaw).map(([name, spec]) => ({
      name,
      fields: parseFieldMap(
        asRecord(spec, `shared_types.${name}`)['fields'],
        `shared_types.${name}.fields`,
      ),
    })),
    objectTypes,
    relationTypes,
    actionTypes,
    stateMachines,
    rules,
  };

  // The digest is over the parsed model, not the file bytes: reformatting a YAML file or
  // changing a comment must not invalidate every generated artifact, but changing a
  // declaration must.
  return { ...ontology, sourceDigest: digest(ontology) };
}
