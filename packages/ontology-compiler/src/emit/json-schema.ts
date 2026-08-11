/**
 * JSON Schema 2020-12 emitter — the graph exchange envelope and every typed object.
 *
 * This is the artifact that decides whether an instance is well formed. It is generated so
 * that the schema and the ontology cannot disagree: there is no second place to edit.
 */

import type { Field, Ontology, ObjectType } from '../model.js';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** `work_order` -> `WorkOrderNode`, matching the R01 pack's $defs naming. */
export function defName(objectTypeId: string): string {
  return `${objectTypeId
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('')}Node`;
}

function unwrapArray(type: string): string | null {
  const m = /^array<(.+)>$/.exec(type);
  return m ? m[1]! : null;
}

const SHARED = new Set(['Money', 'ExternalReference', 'EvidenceReference']);

function scalar(kind: string, f: Field, o: Ontology): Json {
  switch (kind) {
    case 'uuid':
      return { type: 'string', pattern: o.uuidPattern };
    case 'timestamp':
      return { type: 'string', format: 'date-time' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'uri':
      return { type: 'string', format: 'uri' };
    case 'email':
      return { type: 'string', format: 'email' };
    case 'integer':
    case 'number':
    case 'boolean':
      return { type: kind };
    case 'enum': {
      const values =
        f.valuesFrom === 'classifications'
          ? o.classifications
          : f.valuesFrom === 'source_authorities'
            ? o.sourceAuthorities
            : f.valuesFrom === 'authority_domains'
              ? o.authorityDomains
              : (f.values ?? []);
      return { type: 'string', enum: [...values] };
    }
    case 'json': {
      const s: Record<string, Json> = { type: 'object' };
      if (f.propertyNamePattern !== undefined) {
        s['propertyNames'] = { pattern: f.propertyNamePattern };
        s['additionalProperties'] = true;
      }
      return s;
    }
    case 'object': {
      // A structured line item: not a first-class object, but still shaped and validated.
      if (f.itemFields !== undefined) {
        const required = f.itemFields.filter((sf) => sf.required).map((sf) => sf.name);
        const s: Record<string, Json> = {
          type: 'object',
          properties: Object.fromEntries(f.itemFields.map((sf) => [sf.name, fieldSchema(sf, o)])),
        };
        if (required.length > 0) s['required'] = required;
        s['additionalProperties'] = false;
        return s;
      }
      return {
        type: 'object',
        properties: Object.fromEntries((f.properties ?? []).map((p) => [p, {}])),
      };
    }
    case 'string': {
      const s: Record<string, Json> = { type: 'string' };
      if (f.pattern !== undefined) s['pattern'] = f.pattern;
      if (f.anyOfPatterns !== undefined) {
        s['anyOf'] = f.anyOfPatterns.map((p) => ({ pattern: p }));
      }
      if (f.minLength !== undefined) s['minLength'] = f.minLength;
      if (f.maxLength !== undefined) s['maxLength'] = f.maxLength;
      return s;
    }
    default:
      if (SHARED.has(kind)) return { $ref: `#/$defs/${kind}` };
      throw new Error(`json-schema: no encoding for field type '${kind}' on '${f.name}'`);
  }
}

export function fieldSchema(f: Field, o: Ontology): Json {
  if (f.constSchemaVersion === true) return { type: 'string', const: o.schemaVersion };

  const inner = unwrapArray(f.type);
  if (inner === null) {
    const s = scalar(f.type, f, o) as Record<string, Json>;
    if (f.constValue !== undefined) s['const'] = f.constValue;
    if (f.minimum !== undefined) s['minimum'] = f.minimum;
    if (f.maximum !== undefined) s['maximum'] = f.maximum;
    if (f.defaultValue !== undefined) s['default'] = f.defaultValue as Json;
    return s;
  }

  const items: Record<string, Json> = { ...(scalar(inner, f, o) as Record<string, Json>) };
  // Item-level constraints on an array field describe the ELEMENT, not the array.
  if (f.itemPattern !== undefined) items['pattern'] = f.itemPattern;
  if (f.itemMinLength !== undefined) items['minLength'] = f.itemMinLength;
  if (f.itemMaxLength !== undefined) items['maxLength'] = f.itemMaxLength;
  // A list of references is a set: the same target appearing twice carries no extra meaning
  // and would double-count in any aggregate. Free-text lists stay ordered and may repeat.
  const unique = f.unique ?? inner === 'uuid';
  const out: Record<string, Json> = { type: 'array', items };
  if (f.minItems !== undefined) out['minItems'] = f.minItems;
  if (unique) out['uniqueItems'] = true;
  if (f.defaultValue !== undefined) out['default'] = f.defaultValue as Json;
  return out;
}

function nodeDef(t: ObjectType, o: Ontology): Json {
  const properties: Record<string, Json> = {};

  for (const f of o.envelopeFields) {
    properties[f.name] = fieldSchema(f, o);
    if (f.defaultValue !== undefined && unwrapArray(f.type) === null) {
      (properties[f.name] as Record<string, Json>)['default'] = f.defaultValue as Json;
    }
  }
  // node_type and state are the two per-type members of the envelope.
  properties['node_type'] = { const: t.id };
  properties['state'] = { type: 'string', enum: [...t.states] };

  const ordered: Record<string, Json> = {};
  for (const name of [
    'schema_version',
    'node_id',
    'node_type',
    'enterprise_id',
    'title',
    'state',
    'classification',
    'owner',
    'created_at',
    'created_by',
    'updated_at',
    'updated_by',
    'source_authority',
    'aliases',
    'tags',
    'external_refs',
    'extensions',
  ]) {
    const v = properties[name];
    if (v !== undefined) ordered[name] = v;
  }

  const attrProps: Record<string, Json> = {};
  for (const f of t.fields) attrProps[f.name] = fieldSchema(f, o);

  ordered['attributes'] = {
    type: 'object',
    properties: attrProps,
    required: t.fields.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  };

  return {
    type: 'object',
    properties: ordered,
    required: [...o.envelopeRequired, 'attributes'],
    additionalProperties: false,
  };
}

function sharedDef(name: string, o: Ontology): Json {
  const st = o.sharedTypes.find((s) => s.name === name);
  if (st === undefined) throw new Error(`json-schema: shared type '${name}' is not defined`);
  const required = st.fields.filter((f) => f.required).map((f) => f.name);
  return {
    type: 'object',
    properties: Object.fromEntries(st.fields.map((f) => [f.name, fieldSchema(f, o)])),
    ...(required.length > 0 ? { required } : {}),
    // When every field is optional an empty object would otherwise validate — a reference
    // that points at nothing. Demand at least one.
    ...(required.length === 0 ? { minProperties: 1 } : {}),
    additionalProperties: false,
  };
}

function edgeDef(o: Ontology): Json {
  const uuid = { type: 'string', pattern: o.uuidPattern };
  return {
    type: 'object',
    properties: {
      schema_version: { type: 'string', const: o.schemaVersion },
      edge_id: uuid,
      edge_type: { type: 'string', enum: o.relationTypes.map((r) => r.id) },
      source: uuid,
      target: uuid,
      state: { type: 'string', enum: ['active', 'inactive', 'superseded'] },
      scope: uuid,
      created_at: { type: 'string', format: 'date-time' },
      created_by: uuid,
      // An edge that carries a material assertion records the action that authorized it,
      // so authority is attached to the relationship and not only to the endpoints.
      authorizing_action: uuid,
      qualifiers: {
        type: 'object',
        properties: {
          quantity: { type: 'string', pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' },
          unit: { type: 'string' },
          sequence: { type: 'integer', minimum: 0 },
          effective_from: { type: 'string', format: 'date-time' },
          effective_to: { type: 'string', format: 'date-time' },
          amount: { $ref: '#/$defs/Money' },
          percent: { type: 'string', pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' },
          reason: { type: 'string' },
        },
        additionalProperties: false,
      },
      evidence: { type: 'array', items: { $ref: '#/$defs/EvidenceReference' } },
    },
    required: [
      'schema_version',
      'edge_id',
      'edge_type',
      'source',
      'target',
      'state',
      'created_at',
      'created_by',
    ],
    additionalProperties: false,
  };
}

function actionDef(o: Ontology): Json {
  const uuid = { type: 'string', pattern: o.uuidPattern };
  return {
    type: 'object',
    properties: {
      schema_version: { type: 'string', const: o.schemaVersion },
      action_id: uuid,
      action_type: { type: 'string', enum: o.actionTypes.map((a) => a.id) },
      actor: uuid,
      // The role EXERCISED, not every role held. One person may hold several; the audit
      // record has to say which authority was used.
      // At least one, and each named once: an action with no recorded authority, or one
      // that lists the same role twice, cannot answer 'under what authority'.
      acting_roles: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
      occurred_at: { type: 'string', format: 'date-time' },
      transaction_id: uuid,
      idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
      targets: { type: 'array', items: uuid, minItems: 1, uniqueItems: true },
      input: { type: 'object' },
      preconditions: { type: 'array', items: { type: 'string' } },
      result: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['applied', 'rejected', 'failed'] },
          message: { type: 'string' },
          created_nodes: { type: 'array', items: uuid },
          created_edges: { type: 'array', items: uuid },
          before_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          after_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      reason: { type: 'string' },
      evidence: { type: 'array', items: { $ref: '#/$defs/EvidenceReference' } },
    },
    required: [
      'schema_version',
      'action_id',
      'action_type',
      'actor',
      'acting_roles',
      'occurred_at',
      'transaction_id',
      'idempotency_key',
      'targets',
      'input',
      'result',
    ],
    additionalProperties: false,
  };
}

export function emitJsonSchema(o: Ontology): Json {
  const uuid = { type: 'string', pattern: o.uuidPattern };
  const defs: Record<string, Json> = {
    Money: sharedDef('Money', o),
    ExternalReference: sharedDef('ExternalReference', o),
    EvidenceReference: sharedDef('EvidenceReference', o),
    Edge: edgeDef(o),
    Action: actionDef(o),
  };
  for (const t of o.objectTypes) defs[defName(t.id)] = nodeDef(t, o);

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:oh:kf:schema:${o.schemaVersion}`,
    title: 'OpenHuman Knowledge Fabric Organizational Graph Exchange',
    description:
      'Normative machine-readable graph envelope for the organizational graph and work-control specification.',
    // Provenance is source-derived, never wall-clock: a timestamp would make every build
    // differ from the last and defeat the generated-vs-committed drift check.
    'x-generated-from': {
      ontology_version: o.schemaVersion,
      source_digest: o.sourceDigest,
    },
    type: 'object',
    properties: {
      schema_version: { type: 'string', const: o.schemaVersion },
      export_id: uuid,
      generated_at: { type: 'string', format: 'date-time' },
      generated_by: uuid,
      nodes: {
        type: 'array',
        items: { oneOf: o.objectTypes.map((t) => ({ $ref: `#/$defs/${defName(t.id)}` })) },
      },
      edges: { type: 'array', items: { $ref: '#/$defs/Edge' } },
      actions: { type: 'array', items: { $ref: '#/$defs/Action' } },
      metadata: {
        type: 'object',
        properties: {
          source_system: { type: 'string' },
          as_of: { type: 'string', format: 'date-time' },
          content_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        additionalProperties: false,
      },
    },
    required: [
      'schema_version',
      'export_id',
      'generated_at',
      'generated_by',
      'nodes',
      'edges',
      'actions',
    ],
    additionalProperties: false,
    $defs: defs,
  };
}
