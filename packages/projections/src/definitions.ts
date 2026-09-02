import { readFileSync } from 'node:fs';
import type { ProjectionDefinition } from '@kf/ontology-compiler';

/**
 * Pack-shipped definitions are read from the compiled artifact, not from `ontology/`: the
 * artifact is what a release tree carries, and it names the source digest it was built from.
 */
export interface ProjectionDefinitionSet {
  readonly sourceDigest: string;
  readonly schemaVersion: string;
  readonly definitions: readonly ProjectionDefinition[];
  byId(id: string): ProjectionDefinition | undefined;
}

export function loadProjectionDefinitions(artifactPath: string): ProjectionDefinitionSet {
  const raw = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    readonly schema_version?: unknown;
    readonly 'x-generated-from'?: { readonly source_digest?: unknown };
    readonly projection_definitions?: unknown;
  };
  const definitions = raw.projection_definitions;
  const sourceDigest = raw['x-generated-from']?.source_digest;
  if (!Array.isArray(definitions) || typeof sourceDigest !== 'string') {
    throw new Error(`${artifactPath} is not a compiled projections artifact`);
  }
  const list = definitions as ProjectionDefinition[];
  return {
    sourceDigest,
    schemaVersion: String(raw.schema_version ?? ''),
    definitions: list,
    byId: (id) => list.find((d) => d.id === id),
  };
}
