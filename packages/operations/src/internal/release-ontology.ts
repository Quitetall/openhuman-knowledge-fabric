import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tx } from '@kf/database';
import type { ReleaseOntology } from './contracts.js';

/**
 * The projections artifact a release tree carries. Its `x-generated-from.source_digest` is the
 * ontology digest the release was compiled from; the API loads the same file to serve
 * projections, so readiness and the API compare the database against one declaration.
 */
export const DEFAULT_PROJECTIONS_ARTIFACT =
  'generated/projections/knowledge-fabric.projections.json';

const DIGEST = /^[0-9a-f]{64}$/;

/** The ontology digest a compiled projections artifact declares. Throws when it declares none. */
export function readReleaseOntologyDigest(artifactPath: string): string {
  const raw = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    readonly 'x-generated-from'?: { readonly source_digest?: unknown };
  };
  const digest = raw['x-generated-from']?.source_digest;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new Error(`${artifactPath} declares no x-generated-from.source_digest`);
  }
  return digest;
}

/**
 * Where this process's release declares its ontology digest, and what it says. Never throws: an
 * artifact that is missing or malformed becomes a `problem`, which fails the comparison closed.
 */
export function resolveReleaseOntology(
  options: {
    readonly artifactPath?: string | undefined;
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  } = {},
): ReleaseOntology {
  const env = options.env ?? process.env;
  const configured = env['KF_PROJECTIONS_ARTIFACT'];
  const source =
    options.artifactPath ??
    (configured !== undefined && configured !== ''
      ? configured
      : resolve(options.cwd ?? process.cwd(), DEFAULT_PROJECTIONS_ARTIFACT));
  try {
    return { digest: readReleaseOntologyDigest(source), source };
  } catch (err: unknown) {
    return {
      digest: undefined,
      source,
      problem: err instanceof Error ? err.message : String(err),
    };
  }
}

export type InstalledOntology =
  | { readonly status: 'match'; readonly version: string; readonly installed: string }
  | { readonly status: 'mismatch'; readonly version: string; readonly installed: string }
  | { readonly status: 'absent' };

/**
 * Compare the database's current schema release with the digest a release expects
 * (KF-SAS-RQ-081). `absent` means the seed never ran.
 */
export async function compareInstalledOntology(
  tx: Tx,
  expectedDigest: string,
): Promise<InstalledOntology> {
  const row = await tx.maybeOne<{ version: string; ontology_digest: string }>(
    'select version, ontology_digest from registry.schema_release where is_current',
  );
  if (row === undefined) return { status: 'absent' };
  return {
    status: row.ontology_digest === expectedDigest ? 'match' : 'mismatch',
    version: row.version,
    installed: row.ontology_digest,
  };
}

/** One sentence an operator can act on, for a startup refusal or a log line. */
export function describeOntologyMismatch(
  release: ReleaseOntology,
  installed: InstalledOntology | undefined,
): string | undefined {
  if (release.digest === undefined) {
    return (
      `cannot determine this release's ontology digest from ${release.source} ` +
      `(${release.problem}), so the database's seeded ontology cannot be verified`
    );
  }
  if (installed === undefined || installed.status === 'match') return undefined;
  if (installed.status === 'absent') {
    return 'no current schema release: the ontology seed has not been applied';
  }
  return (
    `the database's current schema release ${installed.version} was seeded from ontology ` +
    `${installed.installed.slice(0, 12)}, but this release was compiled from ` +
    `${release.digest.slice(0, 12)} (${release.source}); the code and the database disagree ` +
    'about what the words mean. Run the reviewed migration for this release.'
  );
}
