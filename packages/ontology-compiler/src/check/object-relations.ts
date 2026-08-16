import type { Field } from '../model.js';
import type { CheckContext } from './types.js';

const SCALAR_KINDS = new Set([
  'string',
  'uuid',
  'timestamp',
  'date',
  'uri',
  'email',
  'integer',
  'number',
  'boolean',
  'enum',
  'json',
  'object',
]);

function unwrap(type: string): string {
  const m = /^array<(.+)>$/.exec(type);
  return m ? m[1]! : type;
}

export function checkObjectTypes(context: CheckContext): void {
  const { ontology: o, machineIds } = context;
  for (const t of o.objectTypes) {
    if (!o.authorityDomains.includes(t.authority_domain)) {
      context.err(
        'ONT-002',
        `object_types.${t.id}.authority_domain`,
        `unknown authority domain '${t.authority_domain}'`,
        `Use one of: ${o.authorityDomains.join(', ')}`,
      );
    }
    if (t.state_machine !== null && !machineIds.has(t.state_machine)) {
      context.err(
        'ONT-002',
        `object_types.${t.id}.state_machine`,
        `references undefined state machine '${t.state_machine}'`,
        'Define it in state-machines.yaml or set state_machine: null.',
      );
    }
    if (t.states.length === 0) {
      context.err(
        'ONT-002',
        `object_types.${t.id}.states`,
        'declares no states',
        'Every object type needs at least one state, even if it has no transitions.',
      );
    }
    checkFields(context, t.id, t.fields);
  }
}

function checkFields(context: CheckContext, typeId: string, fields: readonly Field[]): void {
  for (const f of fields) {
    const base = unwrap(f.type);
    if (!SCALAR_KINDS.has(base) && !context.sharedNames.has(base)) {
      context.err(
        'ONT-003',
        `object_types.${typeId}.fields.${f.name}`,
        `unknown field type '${f.type}'`,
        `Use a scalar kind or a shared type (${[...context.sharedNames].join(', ')}).`,
      );
    }
    if (base === 'enum' && (f.values === undefined || f.values.length === 0)) {
      context.err(
        'ONT-003',
        `object_types.${typeId}.fields.${f.name}`,
        'enum field declares no values',
        'An enum with no values can never validate. Add values, or use type: string.',
      );
    }
  }
}

export function checkRelationTypes(context: CheckContext): void {
  for (const r of context.ontology.relationTypes) {
    if (r.symmetric && r.inverse !== r.id) {
      context.err(
        'ONT-004',
        `relation_types.${r.id}`,
        `symmetric relation must be its own inverse, got '${r.inverse}'`,
        'Set inverse to the relation id, or drop symmetric.',
      );
    }
    if (r.symmetric && r.acyclic) {
      context.err(
        'ONT-004',
        `relation_types.${r.id}`,
        'a symmetric relation cannot be acyclic',
        'Any symmetric edge is a two-node cycle by definition. Drop one of the flags.',
      );
    }
    if (!r.symmetric && context.relationIds.has(r.inverse)) {
      context.err(
        'ONT-004',
        `relation_types.${r.id}.inverse`,
        `inverse label '${r.inverse}' is also a forward relation id`,
        'Rename the inverse. Traversal must be unambiguous in both directions.',
      );
    }
    checkRelationSide(context, r.id, 'source_types', r.sourceTypes);
    checkRelationSide(context, r.id, 'target_types', r.targetTypes);
  }
}

function checkRelationSide(
  context: CheckContext,
  relationId: string,
  side: 'source_types' | 'target_types',
  types: readonly string[] | undefined,
): void {
  if (types === undefined) {
    context.findings.push({
      rule: 'ONT-012',
      severity: 'warning',
      path: `relation_types.${relationId}.${side}`,
      message: `relation '${relationId}' does not declare ${side}`,
      remediation: `Declare which object types may sit at this end of '${relationId}'.`,
    });
    return;
  }
  if (types.length === 0) {
    context.err(
      'ONT-012',
      `relation_types.${relationId}.${side}`,
      `${side} is empty`,
      'An empty list permits nothing. Name the types, or omit the key entirely.',
    );
  }
  for (const t of types) {
    if (!context.objectIds.has(t)) {
      context.err(
        'ONT-012',
        `relation_types.${relationId}.${side}`,
        `references undefined object type '${t}'`,
        'Define the object type or correct the reference.',
      );
    }
  }
}
