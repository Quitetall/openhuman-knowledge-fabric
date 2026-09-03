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
  /** Whether this relation can seed relevance from a person anchor. */
  readonly personAnchor?: boolean;
  /** How relevance may propagate across this relation. */
  readonly propagationClass?:
    | 'composition_down'
    | 'version_both'
    | 'provenance_backward'
    | 'lateral_none'
    | 'authority_one_hop_up';
  /** Maximum traversal depth from an anchor for this relation. */
  readonly anchorDepth?: number;
}

// ── corpus projections (ADR 0013; ontology/projections.yaml) ────────────────────────────

export type ProjectionSelect = 'anchor' | 'reached' | 'unreached' | 'withdrawn' | 'all';

/** A narrowing. Every field is optional; an absent field admits everything. */
export interface ProjectionFilter {
  readonly objectTypes?: readonly string[];
  readonly lifecycleStates?: readonly string[];
  /** Admit only members at or below this classification. Narrows; never widens. */
  readonly classificationMax?: string;
  readonly itemStates?: readonly ('included' | 'withdrawn')[];
  /**
   * Admit only members the traversal reached (or did not). At definition level this is the
   * declared scope of a neighbourhood reading — an object view keeps the object and what
   * touches it, not the whole corpus — and what it excludes is counted, never silent.
   */
  readonly reachability?: 'reached' | 'unreached';
}

export interface ProjectionSection {
  readonly id: string;
  readonly title: string;
  readonly select: ProjectionSelect;
  readonly filter?: ProjectionFilter;
}

export interface ProjectionParameter {
  readonly name: string;
  readonly type: 'uuid' | 'integer' | 'string' | 'enum' | 'boolean';
  readonly required: boolean;
  readonly values?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ProjectionTraverse {
  /**
   * `person_anchors` = every relation type declaring person_anchor: true, walked by propagation
   * class (a relevance reading); `all` = every relation type, both directions, as a structural
   * neighbourhood (an object reading); or an explicit list.
   */
  readonly relations: 'person_anchors' | 'all' | readonly string[];
  readonly maxDepth: number;
}

export interface ProjectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  /**
   * `person`: the person the corpus was compiled for. `object`: a member named by the required
   * `object_id` parameter — the reading is anchored inside the corpus, never outside it.
   */
  readonly anchor: 'person' | 'object';
  readonly parameters: readonly ProjectionParameter[];
  readonly filter?: ProjectionFilter;
  readonly traverse?: ProjectionTraverse;
  /** Ordered. The first section whose select admits a member takes it. */
  readonly sections: readonly ProjectionSection[];
  /** Mandatory last section: whatever no section claimed. Its presence is the coverage check. */
  readonly remainder: { readonly id: string; readonly title: string };
  readonly sort: readonly string[];
  readonly budgets: { readonly maxMembers: number };
}

export interface ActionType {
  readonly id: string;
  readonly audited: boolean;
  readonly transactional: boolean;
  /** State machines this action can drive. Empty means it drives no lifecycle. */
  readonly drives: readonly string[];
  /**
   * ADR 0016: `act` means the dispatcher requires a live act grant reaching the target's scope
   * (or the organization). Absent means the action is role-only.
   */
  readonly requires?: 'act';
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
  readonly projectionDefinitions: readonly ProjectionDefinition[];
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
    'projections.yaml',
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
    if (r['person_anchor'] !== undefined) {
      if (typeof r['person_anchor'] !== 'boolean') {
        throw new Error(`relation_types[${i}].person_anchor: expected boolean`);
      }
      rel['personAnchor'] = r['person_anchor'];
    }
    if (r['propagation_class'] !== undefined) {
      rel['propagationClass'] = asString(
        r['propagation_class'],
        `relation_types[${i}].propagation_class`,
      );
    }
    if (r['anchor_depth'] !== undefined) {
      if (
        typeof r['anchor_depth'] !== 'number' ||
        !Number.isInteger(r['anchor_depth']) ||
        r['anchor_depth'] < 0
      ) {
        throw new Error(`relation_types[${i}].anchor_depth: expected non-negative integer`);
      }
      rel['anchorDepth'] = r['anchor_depth'];
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
      ...(r['requires'] === undefined
        ? {}
        : {
            requires: (() => {
              if (r['requires'] !== 'act') {
                throw new Error(`action_types[${i}].requires must be 'act' when present`);
              }
              return 'act' as const;
            })(),
          }),
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

  const projectionDefinitions: ProjectionDefinition[] = asArray(
    asRecord(readYaml(dir, 'projections.yaml'), 'projections.yaml')['projection_definitions'],
    'projection_definitions',
  ).map((raw, i) => {
    const r = asRecord(raw, `projection_definitions[${i}]`);
    const id = asString(r['id'], `projection_definitions[${i}].id`);
    const where = `projection_definitions.${id}`;
    const filter = (value: unknown, at: string): ProjectionFilter | undefined => {
      if (value === undefined) return undefined;
      const f = asRecord(value, at);
      const out: Record<string, unknown> = {};
      if (f['object_types'] !== undefined) {
        out['objectTypes'] = asStringList(f['object_types'], `${at}.object_types`);
      }
      if (f['lifecycle_states'] !== undefined) {
        out['lifecycleStates'] = asStringList(f['lifecycle_states'], `${at}.lifecycle_states`);
      }
      if (f['classification_max'] !== undefined) {
        out['classificationMax'] = asString(f['classification_max'], `${at}.classification_max`);
      }
      if (f['item_states'] !== undefined) {
        out['itemStates'] = asStringList(f['item_states'], `${at}.item_states`);
      }
      if (f['reachability'] !== undefined) {
        const reach = asString(f['reachability'], `${at}.reachability`);
        if (reach !== 'reached' && reach !== 'unreached') {
          throw new OntologyError(`${at}.reachability: expected reached or unreached`);
        }
        out['reachability'] = reach;
      }
      return out as unknown as ProjectionFilter;
    };
    const version = r['version'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new OntologyError(`${where}.version: expected a positive integer`);
    }
    const anchor = asString(r['anchor'], `${where}.anchor`);
    if (anchor !== 'person' && anchor !== 'object') {
      throw new OntologyError(`${where}.anchor: expected person or object`);
    }
    const remainderRaw = asRecord(r['remainder'], `${where}.remainder`);
    const budgetsRaw = asRecord(r['budgets'], `${where}.budgets`);
    const maxMembers = budgetsRaw['max_members'];
    if (typeof maxMembers !== 'number' || !Number.isInteger(maxMembers) || maxMembers < 1) {
      throw new OntologyError(`${where}.budgets.max_members: expected a positive integer`);
    }
    let traverse: ProjectionTraverse | undefined;
    if (r['traverse'] !== undefined) {
      const tr = asRecord(r['traverse'], `${where}.traverse`);
      const relations = tr['relations'];
      const maxDepth = tr['max_depth'];
      if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0) {
        throw new OntologyError(`${where}.traverse.max_depth: expected a non-negative integer`);
      }
      traverse = {
        relations:
          relations === 'person_anchors' || relations === 'all'
            ? relations
            : asStringList(relations, `${where}.traverse.relations`),
        maxDepth,
      };
    }
    const sections: ProjectionSection[] = asArray(r['sections'] ?? [], `${where}.sections`).map(
      (s, j) => {
        const sec = asRecord(s, `${where}.sections[${j}]`);
        const select = asString(sec['select'], `${where}.sections[${j}].select`);
        if (!['anchor', 'reached', 'unreached', 'withdrawn', 'all'].includes(select)) {
          throw new OntologyError(`${where}.sections[${j}].select: unknown select '${select}'`);
        }
        const f = filter(sec['filter'], `${where}.sections[${j}].filter`);
        return {
          id: asString(sec['id'], `${where}.sections[${j}].id`),
          title: asString(sec['title'], `${where}.sections[${j}].title`),
          select: select as ProjectionSelect,
          ...(f === undefined ? {} : { filter: f }),
        };
      },
    );
    const parameters: ProjectionParameter[] = asArray(
      r['parameters'] ?? [],
      `${where}.parameters`,
    ).map((pr, j) => {
      const param = asRecord(pr, `${where}.parameters[${j}]`);
      const type = asString(param['type'], `${where}.parameters[${j}].type`);
      if (!['uuid', 'integer', 'string', 'enum', 'boolean'].includes(type)) {
        throw new OntologyError(`${where}.parameters[${j}].type: unknown parameter type '${type}'`);
      }
      const out: Record<string, unknown> = {
        name: asString(param['name'], `${where}.parameters[${j}].name`),
        type,
        required: param['required'] === true,
      };
      if (param['values'] !== undefined) {
        out['values'] = asStringList(param['values'], `${where}.parameters[${j}].values`);
      }
      if (typeof param['minimum'] === 'number') out['minimum'] = param['minimum'];
      if (typeof param['maximum'] === 'number') out['maximum'] = param['maximum'];
      return out as unknown as ProjectionParameter;
    });
    const topFilter = filter(r['filter'], `${where}.filter`);
    return {
      id,
      title: asString(r['title'], `${where}.title`),
      version,
      anchor,
      parameters,
      ...(topFilter === undefined ? {} : { filter: topFilter }),
      ...(traverse === undefined ? {} : { traverse }),
      sections,
      remainder: {
        id: asString(remainderRaw['id'], `${where}.remainder.id`),
        title: asString(remainderRaw['title'], `${where}.remainder.title`),
      },
      sort: asStringList(r['sort'] ?? [], `${where}.sort`),
      budgets: { maxMembers },
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
    projectionDefinitions,
  };

  // The digest is over the parsed model, not the file bytes: reformatting a YAML file or
  // changing a comment must not invalidate every generated artifact, but changing a
  // declaration must.
  return { ...ontology, sourceDigest: digest(ontology) };
}
