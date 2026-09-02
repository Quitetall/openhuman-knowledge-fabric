/**
 * The build: ontology -> generated artifacts.
 *
 * Deterministic by construction. Every output is a pure function of the ontology model, so
 * two builds of the same source produce identical bytes — which is what makes the
 * generated-versus-committed drift check in CI meaningful.
 *
 * Note there is deliberately NO wall-clock timestamp in any artifact. A generation time
 * would change on every build and make the drift check fire constantly, hiding real
 * changes among noise. `source_digest` answers the same question better: it identifies
 * exactly which ontology produced these bytes, and two artifacts with the same digest are
 * the same artifact regardless of when they were written.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ontology } from './model.js';
import { emitJsonSchema } from './emit/json-schema.js';
import {
  emitJsonLdContext,
  emitShacl,
  emitStateMachines,
  emitVocabulary,
} from './emit/interchange.js';
import { emitDocumentation, emitOpenApi, emitSqlRegistry, emitTypeScript } from './emit/code.js';

export interface Artifact {
  /** Path relative to `generated/`. */
  readonly path: string;
  readonly content: string;
}

/** Stable, human-diffable JSON. Two-space indent and a trailing newline, like the rest of the tree. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildArtifacts(o: Ontology): Artifact[] {
  return [
    { path: 'json-schema/knowledge-fabric.schema.json', content: json(emitJsonSchema(o)) },
    { path: 'vocabulary/knowledge-fabric.vocabulary.json', content: json(emitVocabulary(o)) },
    {
      path: 'state-machines/knowledge-fabric.state-machines.json',
      content: json(emitStateMachines(o)),
    },
    { path: 'jsonld/knowledge-fabric.context.jsonld', content: json(emitJsonLdContext(o)) },
    { path: 'shacl/knowledge-fabric.shacl.ttl', content: emitShacl(o) },
    { path: 'openapi/knowledge-fabric.openapi.json', content: json(emitOpenApi(o)) },
    { path: 'typescript/ontology.ts', content: emitTypeScript(o) },
    { path: 'sql-registry/001-ontology-seed.sql', content: emitSqlRegistry(o) },
    { path: 'documentation/ontology-reference.md', content: emitDocumentation(o) },
    {
      path: 'projections/knowledge-fabric.projections.json',
      content: json({
        schema_version: o.schemaVersion,
        'x-generated-from': { ontology_version: o.schemaVersion, source_digest: o.sourceDigest },
        projection_definitions: o.projectionDefinitions,
      }),
    },
  ];
}

export function writeArtifacts(artifacts: readonly Artifact[], outDir: string): void {
  for (const a of artifacts) {
    const path = join(outDir, a.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, a.content, 'utf8');
  }
}

export interface DriftEntry {
  readonly path: string;
  readonly status: 'missing' | 'changed';
}

/** Compare freshly built artifacts against what is committed. */
export function findDrift(artifacts: readonly Artifact[], outDir: string): DriftEntry[] {
  const drift: DriftEntry[] = [];
  for (const a of artifacts) {
    let onDisk: string;
    try {
      onDisk = readFileSync(join(outDir, a.path), 'utf8');
    } catch {
      drift.push({ path: a.path, status: 'missing' });
      continue;
    }
    if (onDisk !== a.content) drift.push({ path: a.path, status: 'changed' });
  }
  return drift;
}
