/**
 * Code and database emitters: TypeScript types, OpenAPI schemas, SQL registry seeds and
 * human-readable documentation.
 *
 * The SQL seeds are what let PostgreSQL enforce the ontology directly — a state or action
 * token that is not in the ontology fails a foreign key rather than being caught by a
 * hopeful application check.
 */

import type { Field, Ontology } from '../model.js';
import type { Json } from './json-schema.js';
import { defName, emitJsonSchema } from './json-schema.js';

const BANNER = (o: Ontology, comment: string): string =>
  [
    `${comment} GENERATED from ontology/ — do not edit.`,
    `${comment} ontology_version: ${o.schemaVersion}`,
    `${comment} source_digest: ${o.sourceDigest}`,
    '',
  ].join('\n');

function pascal(id: string): string {
  return id
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
}

function tsType(f: Field, o: Ontology): string {
  const arr = /^array<(.+)>$/.exec(f.type);
  if (arr) return `readonly ${tsType({ ...f, type: arr[1]! }, o)}[]`;
  switch (f.type) {
    case 'uuid':
    case 'timestamp':
    case 'date':
    case 'uri':
    case 'email':
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum': {
      const values =
        f.valuesFrom === 'classifications'
          ? o.classifications
          : f.valuesFrom === 'source_authorities'
            ? o.sourceAuthorities
            : f.valuesFrom === 'authority_domains'
              ? o.authorityDomains
              : (f.values ?? []);
      return values.map((v) => `'${v}'`).join(' | ');
    }
    case 'json':
    case 'object':
      return 'Readonly<Record<string, unknown>>';
    default:
      return f.type; // a shared type name
  }
}

export function emitTypeScript(o: Ontology): string {
  const out: string[] = [BANNER(o, '//')];
  out.push('/* eslint-disable */');
  out.push('');
  out.push(`export const SCHEMA_VERSION = '${o.schemaVersion}' as const;`);
  out.push(`export const ONTOLOGY_SOURCE_DIGEST = '${o.sourceDigest}' as const;`);
  out.push('');

  const union = (name: string, values: readonly string[]): void => {
    out.push(
      `export const ${name} = [${values.map((v) => `'${v}'`).join(', ')}] as const;`,
      `export type ${pascal(name.toLowerCase())} = (typeof ${name})[number];`,
      '',
    );
  };
  union('CLASSIFICATIONS', o.classifications);
  union('SOURCE_AUTHORITIES', o.sourceAuthorities);
  union('AUTHORITY_DOMAINS', o.authorityDomains);
  union(
    'OBJECT_TYPES',
    o.objectTypes.map((t) => t.id),
  );
  union(
    'RELATION_TYPES',
    o.relationTypes.map((r) => r.id),
  );
  union(
    'ACTION_TYPES',
    o.actionTypes.map((a) => a.id),
  );

  for (const st of o.sharedTypes) {
    out.push(`export interface ${st.name} {`);
    for (const f of st.fields) {
      out.push(`  readonly ${f.name}${f.required ? '' : '?'}: ${tsType(f, o)};`);
    }
    out.push('}', '');
  }

  for (const t of o.objectTypes) {
    out.push(`/** ${t.title} — authority: ${t.authority_domain} */`);
    out.push(
      `export type ${pascal(t.id)}State = ${t.states.map((s) => `'${s}'`).join(' | ')};`,
      `export interface ${pascal(t.id)}Attributes {`,
    );
    for (const f of t.fields) {
      out.push(`  readonly ${f.name}${f.required ? '' : '?'}: ${tsType(f, o)};`);
    }
    out.push('}', '');
  }

  out.push('/** State machines, keyed by object type. */');
  out.push('export const STATE_MACHINES = {');
  for (const m of o.stateMachines) {
    out.push(`  ${m.id}: {`);
    out.push(`    initial: '${m.initial}',`);
    out.push(`    terminal: [${m.terminal.map((s) => `'${s}'`).join(', ')}],`);
    out.push('    transitions: [');
    for (const t of m.transitions) {
      out.push(`      { from: '${t.from}', to: '${t.to}', action: '${t.action}' },`);
    }
    out.push('    ],', '  },');
  }
  out.push('} as const;', '');

  out.push('/** Machine-enforceable invariants and where each is enforced. */');
  out.push('export const RULES = [');
  for (const r of o.rules) {
    out.push(
      `  { id: '${r.id}', severity: '${r.severity}', implementation: [${r.implementation
        .map((i) => `'${i}'`)
        .join(', ')}], description: ${JSON.stringify(r.description)} },`,
    );
  }
  out.push('] as const;', '');

  out.push(
    '/** Corpus projection definitions — declared readings of a master record (ADR 0013). */',
  );
  out.push(
    `export const PROJECTION_DEFINITIONS = ${JSON.stringify(o.projectionDefinitions, null, 2)} as const;`,
    `export type ProjectionDefinitionId = (typeof PROJECTION_DEFINITIONS)[number]['id'];`,
    '',
  );
  return out.join('\n');
}

export function emitOpenApi(o: Ontology): Json {
  const schema = emitJsonSchema(o) as Record<string, Json>;
  const defs = schema['$defs'] as Record<string, Json>;
  // OpenAPI 3.1 is a JSON Schema 2020-12 dialect, so the definitions transfer directly;
  // only the $ref base changes.
  const components = JSON.parse(
    JSON.stringify(defs).replaceAll('#/$defs/', '#/components/schemas/'),
  ) as Record<string, Json>;

  const paths: Record<string, Json> = {};
  for (const t of o.objectTypes) {
    paths[`/objects/${t.id}/{id}`] = {
      get: {
        summary: `Read a ${t.title}`,
        operationId: `get_${t.id}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: t.title,
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${defName(t.id)}` } },
            },
          },
          '403': { description: 'Not permitted, with an explainable reason' },
          '404': { description: 'No such object, or not visible to this actor' },
        },
      },
    };
  }
  // Actions are POST-only and named. There is deliberately no PATCH anywhere in this API:
  // a controlled record changes because an action moved it, never by field assignment.
  for (const a of o.actionTypes) {
    paths[`/actions/${a.id}`] = {
      post: {
        summary: `Execute ${a.id}`,
        operationId: a.id,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Action' } } },
        },
        responses: {
          '200': { description: 'Applied, or replayed from the idempotency key' },
          '403': { description: 'Actor lacks the authority for this action' },
          '409': { description: 'Precondition failed — state or version moved' },
          '422': { description: 'Input failed schema or invariant validation' },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenHuman Knowledge Fabric API',
      version: o.schemaVersion,
      description: `Generated from ontology source digest ${o.sourceDigest}.`,
    },
    paths,
    components: { schemas: components },
  };
}

export function emitSqlRegistry(o: Ontology): string {
  const q = (s: string): string => `'${s.replaceAll("'", "''")}'`;
  const out: string[] = [BANNER(o, '--')];
  out.push(
    '-- Seed data for the registry schema. Generated; applied by `pnpm db:seed`.',
    '--',
    '-- These tables are the database-side copy of the ontology. Domain tables reference them,',
    '-- so a state or action token the ontology does not define fails a foreign key instead of',
    '-- being caught only by an application check that someone might bypass.',
    '--',
    '-- UPSERT, not delete-and-insert. Re-seeding after an ontology change must not fail merely',
    '-- because a type is in use. Rows the ontology NO LONGER declares are deleted at the end,',
    '-- and that delete is meant to fail if records still reference them: a type you cannot',
    '-- remove is a type you should not be silently removing.',
    '',
    'begin;',
    '',
  );

  const ids = (xs: readonly { id: string }[]): string =>
    `array[${xs.map((x) => q(x.id)).join(', ')}]::text[]`;

  out.push(
    '-- Retire the previous current release BEFORE inserting the new current row. The unique',
    '-- partial index rejects two current rows even within one transaction.',
    `update registry.schema_release set is_current = false where version <> ${q(o.schemaVersion)};`,
    '',
    `insert into registry.schema_release (version, ontology_digest, is_current) values`,
    `  (${q(o.schemaVersion)}, ${q(o.sourceDigest)}, true)`,
    'on conflict (version) do update set ontology_digest = excluded.ontology_digest,',
    '  applied_at = now(), is_current = true;',
    '',
  );

  out.push(
    'insert into registry.object_type (id, title, authority_domain, enterprise_namespace, first_class) values',
    o.objectTypes
      .map(
        (t) =>
          `  (${q(t.id)}, ${q(t.title)}, ${q(t.authority_domain)}, ${
            t.enterprise_namespace === null ? 'null' : q(t.enterprise_namespace)
          }, ${t.first_class})`,
      )
      .join(',\n') +
      '\non conflict (id) do update set title = excluded.title,\n' +
      '  authority_domain = excluded.authority_domain,\n' +
      '  enterprise_namespace = excluded.enterprise_namespace,\n' +
      '  first_class = excluded.first_class;',
    '',
  );

  out.push(
    'insert into registry.relation_type (id, inverse_label, acyclic, is_symmetric, person_anchor, propagation_class, anchor_depth) values',
    o.relationTypes
      .map(
        (r) =>
          `  (${q(r.id)}, ${q(r.inverse)}, ${r.acyclic}, ${r.symmetric}, ` +
          `${r.personAnchor ?? false}, ${r.propagationClass === undefined ? 'null' : q(r.propagationClass)}, ` +
          `${r.anchorDepth ?? 0})`,
      )
      .join(',\n') +
      '\non conflict (id) do update set inverse_label = excluded.inverse_label,\n' +
      '  acyclic = excluded.acyclic, is_symmetric = excluded.is_symmetric,\n' +
      '  person_anchor = excluded.person_anchor, propagation_class = excluded.propagation_class,\n' +
      '  anchor_depth = excluded.anchor_depth;',
    '',
  );

  out.push(
    'insert into registry.action_type (id, audited, transactional, requires_capability) values',
    o.actionTypes
      .map(
        (a) =>
          `  (${q(a.id)}, ${a.audited}, ${a.transactional}, ${a.requires === undefined ? 'null' : q(a.requires)})`,
      )
      .join(',\n') +
      '\non conflict (id) do update set audited = excluded.audited,\n' +
      '  transactional = excluded.transactional,\n' +
      '  requires_capability = excluded.requires_capability;',
    '',
  );

  // Every object type's states — including the 13 with no transitions, which still have a
  // status and still need core.object's foreign key to resolve.
  out.push(
    'insert into registry.object_state (object_type, state, is_terminal) values',
    o.objectTypes
      .flatMap((t) => {
        const machine = o.stateMachines.find((m) => m.id === t.state_machine);
        return t.states.map(
          (st) => `  (${q(t.id)}, ${q(st)}, ${machine ? machine.terminal.includes(st) : false})`,
        );
      })
      .join(',\n') +
      '\non conflict (object_type, state) do update set is_terminal = excluded.is_terminal;',
    '',
  );

  out.push(
    'insert into registry.state_machine (id, initial_state) values',
    o.stateMachines.map((m) => `  (${q(m.id)}, ${q(m.initial)})`).join(',\n') +
      '\non conflict (id) do update set initial_state = excluded.initial_state;',
    '',
  );

  out.push(
    'insert into registry.state_transition (object_type, from_state, to_state, action_id) values',
    o.stateMachines
      .flatMap((m) =>
        m.transitions.map((t) => `  (${q(m.id)}, ${q(t.from)}, ${q(t.to)}, ${q(t.action)})`),
      )
      .join(',\n') + '\non conflict do nothing;',
    '',
  );

  out.push(
    'insert into registry.rule_definition (id, severity, description, implementation) values',
    o.rules
      .map(
        (r) =>
          `  (${q(r.id)}, ${q(r.severity)}, ${q(r.description)}, array[${r.implementation
            .map(q)
            .join(', ')}])`,
      )
      .join(',\n') +
      '\non conflict (id) do update set severity = excluded.severity,\n' +
      '  description = excluded.description, implementation = excluded.implementation;',
    '',
  );

  out.push(
    '-- Retire what the ontology no longer declares. These deletes are SUPPOSED to fail when',
    '-- records still reference the row: a type still in use must not vanish from the registry.',
    `delete from registry.rule_definition where id <> all (${ids(o.rules)});`,
    'delete from registry.state_transition st where not exists (select 1 from (' +
      o.stateMachines
        .flatMap((m) =>
          m.transitions.map(
            (t) =>
              `select ${q(m.id)} as m, ${q(t.from)} as f, ${q(t.to)} as t, ${q(t.action)} as a`,
          ),
        )
        .join(' union all ') +
      ') x where x.m = st.object_type and x.f = st.from_state and x.t = st.to_state and x.a = st.action_id);',
    `delete from registry.object_state where object_type <> all (${ids(o.objectTypes)});`,
    `delete from registry.state_machine where id <> all (${ids(o.stateMachines)});`,
    `delete from registry.action_type where id <> all (${ids(o.actionTypes)});`,
    `delete from registry.relation_type where id <> all (${ids(o.relationTypes)});`,
    `delete from registry.object_type where id <> all (${ids(o.objectTypes)});`,
    '',
    'commit;',
    '',
  );
  return out.join('\n');
}

export function emitDocumentation(o: Ontology): string {
  const out: string[] = [
    '<!-- GENERATED from ontology/ — do not edit. -->',
    `<!-- ontology_version: ${o.schemaVersion} · source_digest: ${o.sourceDigest} -->`,
    '',
    '# Ontology reference',
    '',
    `Compiled from \`ontology/\`. ${o.objectTypes.length} object types, ` +
      `${o.relationTypes.length} relation types, ${o.actionTypes.length} action types, ` +
      `${o.stateMachines.length} state machines, ${o.rules.length} invariants, ` +
      `${o.projectionDefinitions.length} corpus projections.`,
    '',
    '## Object types',
    '',
    '| Type | Authority | Enterprise namespace | Lifecycle | States |',
    '|---|---|---|---|---|',
  ];
  for (const t of o.objectTypes) {
    const ns = t.enterprise_namespace ?? '—';
    const flag = t.enterprise_namespace_proposed ? ' *(proposed)*' : '';
    out.push(
      `| \`${t.id}\` | ${t.authority_domain} | ${ns}${flag} | ${t.state_machine ?? '—'} | ${t.states.length} |`,
    );
  }

  out.push('', '## Relation types', '', '| Relation | Inverse | Acyclic |', '|---|---|---|');
  for (const r of o.relationTypes) {
    out.push(`| \`${r.id}\` | ${r.inverse} | ${r.acyclic ? 'yes' : ''} |`);
  }

  out.push('', '## Actions', '', '| Action | Drives | Requires |', '|---|---|---|');
  for (const a of o.actionTypes) {
    out.push(
      `| \`${a.id}\` | ${a.drives.length > 0 ? a.drives.join(', ') : '—'} | ${a.requires ?? 'role only'} |`,
    );
  }

  out.push('', '## Lifecycles', '');
  for (const m of o.stateMachines) {
    out.push(
      `### \`${m.id}\``,
      '',
      `Initial: \`${m.initial}\` · Terminal: ${m.terminal.map((t) => `\`${t}\``).join(', ')}`,
      '',
    );
    out.push('```mermaid', 'stateDiagram-v2', `    [*] --> ${m.initial}`);
    for (const t of m.transitions) out.push(`    ${t.from} --> ${t.to}: ${t.action}`);
    for (const t of m.terminal) out.push(`    ${t} --> [*]`);
    out.push('```', '');
  }

  out.push('## Invariants', '', '| Rule | Enforced at | Statement |', '|---|---|---|');
  for (const r of o.rules) {
    out.push(`| \`${r.id}\` | ${r.implementation.join(', ')} | ${r.description} |`);
  }

  out.push(
    '',
    '## Corpus projections',
    '',
    '| Projection | Version | Traverse | Sections | Remainder |',
    '|---|---|---|---|---|',
  );
  for (const d of o.projectionDefinitions) {
    const traverse =
      d.traverse === undefined
        ? '—'
        : `${d.traverse.relations === 'person_anchors' ? 'person anchors' : d.traverse.relations === 'all' ? 'all relations' : d.traverse.relations.join(', ')} ≤ ${d.traverse.maxDepth}`;
    out.push(
      `| \`${d.id}\` | ${d.version} | ${traverse} | ${d.sections.map((s) => `\`${s.id}\` (${s.select})`).join(', ') || '—'} | \`${d.remainder.id}\` |`,
    );
  }
  out.push('');
  return out.join('\n');
}
