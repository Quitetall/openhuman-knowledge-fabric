/**
 * Interchange emitters: controlled vocabulary, state machines, JSON-LD context and SHACL.
 *
 * These are the artifacts other systems read. They exist so federation happens through a
 * published contract rather than by someone reverse-engineering our database.
 */

import type { Ontology } from '../model.js';
import type { Json } from './json-schema.js';

export function emitVocabulary(o: Ontology): Json {
  const nodeTypes: Record<string, Json> = {};
  for (const t of o.objectTypes) {
    const entry: Record<string, Json> = {
      authority_domain: t.authority_domain,
      enterprise_namespace: t.enterprise_namespace,
    };
    // Flagged rather than silently used: a namespace we have not been allocated must not
    // read as one we have. See the R5 amendment request.
    if (t.enterprise_namespace_proposed) entry['proposed_namespace'] = true;
    nodeTypes[t.id] = entry;
  }

  const edgeTypes: Record<string, Json> = {};
  for (const r of o.relationTypes) {
    const entry: Record<string, Json> = { inverse: r.inverse };
    if (r.acyclic) entry['acyclic'] = true;
    if (r.symmetric) entry['symmetric'] = true;
    // Emitted only once declared, so a consumer can tell "any type" from "not yet typed".
    if (r.sourceTypes !== undefined) entry['source_types'] = [...r.sourceTypes];
    if (r.targetTypes !== undefined) entry['target_types'] = [...r.targetTypes];
    if (r.personAnchor !== undefined) entry['person_anchor'] = r.personAnchor;
    if (r.propagationClass !== undefined) entry['propagation_class'] = r.propagationClass;
    if (r.anchorDepth !== undefined) entry['anchor_depth'] = r.anchorDepth;
    edgeTypes[r.id] = entry;
  }

  const actionTypes: Record<string, Json> = {};
  for (const a of o.actionTypes) {
    actionTypes[a.id] = { audited: a.audited, transactional: a.transactional };
  }

  return {
    schema_version: o.schemaVersion,
    'x-generated-from': { ontology_version: o.schemaVersion, source_digest: o.sourceDigest },
    node_types: nodeTypes,
    edge_types: edgeTypes,
    action_types: actionTypes,
    invariants: o.rules.map((r) => r.description),
  };
}

export function emitStateMachines(o: Ontology): Json {
  const machines: Record<string, Json> = {};
  for (const m of o.stateMachines) {
    machines[m.id] = {
      initial: m.initial,
      terminal: [...m.terminal],
      transitions: m.transitions.map((t) => [t.from, t.to, t.action]),
    };
  }
  return {
    schema_version: o.schemaVersion,
    'x-generated-from': { ontology_version: o.schemaVersion, source_digest: o.sourceDigest },
    machines,
  };
}

/**
 * JSON-LD context with W3C PROV mapping.
 *
 * Only relations with a genuine PROV counterpart are mapped. Forcing every domain relation
 * into PROV would assert provenance semantics we do not mean (spec §17.1).
 */
const PROV_RELATIONS: Record<string, string> = {
  produces: 'prov:generated',
  used: 'prov:used',
  performed_by: 'prov:wasAssociatedWith',
  derived_from: 'prov:wasDerivedFrom',
  generated_by: 'prov:wasGeneratedBy',
  was_associated_with: 'prov:wasAssociatedWith',
};

export function emitJsonLdContext(o: Ontology): Json {
  const ctx: Record<string, Json> = {
    '@version': 1.1,
    kf: 'urn:oh:kf:v1:',
    prov: 'http://www.w3.org/ns/prov#',
    oslc: 'http://open-services.net/ns/core#',
    schema: 'https://schema.org/',
    node_id: '@id',
    node_type: '@type',
    title: 'schema:name',
    created_at: {
      '@id': 'prov:generatedAtTime',
      '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
    },
    created_by: { '@id': 'prov:wasAttributedTo', '@type': '@id' },
    owner: { '@id': 'kf:ownedBy', '@type': '@id' },
    source: { '@id': 'kf:source', '@type': '@id' },
    target: { '@id': 'kf:target', '@type': '@id' },
  };
  for (const r of o.relationTypes) {
    const prov = PROV_RELATIONS[r.id];
    ctx[r.id] = { '@id': prov ?? `kf:${r.id}`, '@type': '@id' };
  }
  // Provenance sits BESIDE @context, not inside it. A JSON-LD processor loading a remote
  // context uses only the @context entry and ignores the rest, so this identifies which
  // ontology produced the file without adding a term to the vocabulary.
  return {
    'x-generated-from': { ontology_version: o.schemaVersion, source_digest: o.sourceDigest },
    '@context': ctx,
  };
}

/**
 * SHACL shapes for the constraints that are natural over linked data: required references
 * and their cardinality. Value-range and financial invariants stay in the validator, where
 * they can be expressed without contorting them into graph shape.
 */
export function emitShacl(o: Ontology): string {
  const lines = [
    '# GENERATED from ontology/ — do not edit.',
    `# ontology_version: ${o.schemaVersion}`,
    `# source_digest: ${o.sourceDigest}`,
    '',
    '@prefix sh: <http://www.w3.org/ns/shacl#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix kf: <urn:oh:kf:v1:> .',
    '',
  ];

  for (const t of o.objectTypes) {
    // Required single references are what SHACL expresses well; scalars are already
    // covered by JSON Schema and would only be restated here.
    const refs = t.fields.filter(
      (f) => f.required && (f.type === 'uuid' || f.type === 'array<uuid>'),
    );
    if (refs.length === 0) continue;
    const shape = `${t.id
      .split('_')
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('')}Shape`;
    lines.push(`kf:${shape} a sh:NodeShape ;`);
    lines.push(`  sh:targetClass kf:${t.id} ;`);
    const props = refs.map((f) => {
      const card = f.type === 'uuid' ? 'sh:minCount 1 ; sh:maxCount 1' : 'sh:minCount 1';
      return `  sh:property [ sh:path kf:${f.name} ; ${card} ; sh:nodeKind sh:IRI ]`;
    });
    lines.push(`${props.join(' ;\n')} .`);
    lines.push('');
  }
  return lines.join('\n');
}
