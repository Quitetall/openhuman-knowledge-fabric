import { canonicalize } from '@kf/canonicalization';
import type { ExportPackage, VerificationFinding } from './types.js';
import { EXPORT_FORMAT_VERSION } from './types.js';
import {
  CHECKPOINT_PUBLIC_KEY_EXPORT_PATH,
  DECIMAL_SEQUENCE,
  MANIFEST_PATH,
  SHA256,
  isRecord,
} from './format.js';
import { recomputeDatabaseSnapshotDigest } from './encoding.js';
import { SECTIONS } from './sections.js';
import { checkpointPublicKeyProblem } from './verification-content.js';

/** Enforce the closed format-v2 data model before authenticity can bless an incomplete package. */
export function verifyV2PackageShape(pkg: ExportPackage): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const manifest = pkg.manifest;
  const expectedManifestKeys = [
    'audit_from_seq',
    'audit_to_seq',
    'counts',
    'database_snapshot_sha256',
    'files',
    'format_version',
    'ontology_digest',
    'ontology_version',
    'schema_version',
  ];
  const actualManifestKeys = Object.keys(manifest).sort();
  if (
    actualManifestKeys.length !== expectedManifestKeys.length ||
    actualManifestKeys.some((key, index) => key !== expectedManifestKeys[index])
  ) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'format v2 manifest must use its closed top-level schema',
    });
  }

  const validAuditSequence = (value: unknown): boolean =>
    value === null || (typeof value === 'string' && DECIMAL_SEQUENCE.test(value));
  if (
    manifest.format_version !== EXPORT_FORMAT_VERSION ||
    typeof manifest.ontology_version !== 'string' ||
    manifest.ontology_version === '' ||
    typeof manifest.schema_version !== 'string' ||
    manifest.schema_version === '' ||
    typeof manifest.ontology_digest !== 'string' ||
    !SHA256.test(manifest.ontology_digest) ||
    typeof manifest.database_snapshot_sha256 !== 'string' ||
    !SHA256.test(manifest.database_snapshot_sha256) ||
    !validAuditSequence(manifest.audit_from_seq) ||
    !validAuditSequence(manifest.audit_to_seq)
  ) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'format v2 manifest has an invalid version, ontology, schema, or audit range',
    });
  }

  const sectionNames = SECTIONS.map((section) => section.name);
  const expectedCountKeys = [...sectionNames].sort();
  const counts: unknown = manifest.counts;
  if (!isRecord(counts)) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'format v2 counts must be an object containing every preservation section',
    });
    return findings;
  }
  const actualCountKeys = Object.keys(counts).sort();
  if (
    actualCountKeys.length !== expectedCountKeys.length ||
    actualCountKeys.some((key, index) => key !== expectedCountKeys[index])
  ) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'format v2 counts must name every and only every preservation section',
    });
  }

  const filesByPath = new Map(pkg.files.map((entry) => [entry.path, entry]));
  const listedPaths = new Set<string>();
  for (const entry of manifest.files as readonly unknown[]) {
    if (isRecord(entry) && typeof entry['path'] === 'string') listedPaths.add(entry['path']);
  }
  const requiredPaths = new Set([
    'ontology/registry.json',
    ...sectionNames.map((section) => `${section}.json`),
  ]);
  for (const requiredPath of requiredPaths) {
    if (!listedPaths.has(requiredPath)) {
      findings.push({
        path: requiredPath,
        problem: 'manifest_mismatch',
        detail: 'format v2 requires this preservation file and its manifest entry',
      });
    }
  }

  try {
    const recomputedSnapshot = recomputeDatabaseSnapshotDigest(pkg.files);
    if (manifest.database_snapshot_sha256 !== recomputedSnapshot) {
      findings.push({
        path: MANIFEST_PATH,
        problem: 'manifest_mismatch',
        detail:
          `database snapshot digest is ${String(manifest.database_snapshot_sha256)}, ` +
          `exact preservation bytes recompute to ${recomputedSnapshot}`,
      });
    }
  } catch (error: unknown) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: `database snapshot digest cannot be recomputed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  for (const path of listedPaths) {
    if (!requiredPaths.has(path) && CHECKPOINT_PUBLIC_KEY_EXPORT_PATH.exec(path) === null) {
      findings.push({
        path,
        problem: 'manifest_mismatch',
        detail: 'format v2 contains a file outside its closed preservation schema',
      });
    }
  }

  const ontologyFile = filesByPath.get('ontology/registry.json');
  if (ontologyFile !== undefined) {
    try {
      const ontology: unknown = JSON.parse(ontologyFile.content);
      if (!isRecord(ontology) || ontologyFile.content !== `${canonicalize(ontology)}\n`) {
        throw new Error('not canonical ontology JSON');
      }
    } catch {
      findings.push({
        path: 'ontology/registry.json',
        problem: 'manifest_mismatch',
        detail: 'ontology registry must be one canonical JSON object',
      });
    }
  }

  for (const sectionName of sectionNames) {
    const count = counts[sectionName];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      findings.push({
        path: MANIFEST_PATH,
        problem: 'manifest_mismatch',
        detail: `count for ${sectionName} must be a non-negative safe integer`,
      });
      continue;
    }
    const path = `${sectionName}.json`;
    const sectionFile = filesByPath.get(path);
    if (sectionFile === undefined) continue;
    try {
      const rows: unknown = JSON.parse(sectionFile.content);
      if (!Array.isArray(rows) || sectionFile.content !== `${canonicalize(rows)}\n`) {
        throw new Error('not a canonical row array');
      }
      if (rows.length !== count) {
        findings.push({
          path,
          problem: 'manifest_mismatch',
          detail: `manifest count is ${String(count)}, section contains ${rows.length} rows`,
        });
      }
    } catch {
      findings.push({
        path,
        problem: 'manifest_mismatch',
        detail: 'preservation section must be one canonical JSON array',
      });
    }
  }

  const auditFile = filesByPath.get('audit-events.json');
  if (auditFile !== undefined) {
    try {
      const auditRows = JSON.parse(auditFile.content) as unknown;
      if (!Array.isArray(auditRows)) throw new Error('not an array');
      const sequences = auditRows.map((row, index) => {
        if (
          !isRecord(row) ||
          typeof row['seq'] !== 'string' ||
          !DECIMAL_SEQUENCE.test(row['seq'])
        ) {
          throw new Error(`row ${index} has no exact decimal sequence`);
        }
        return row['seq'];
      });
      const expectedFrom = sequences[0] ?? null;
      const expectedTo = sequences[sequences.length - 1] ?? null;
      if (manifest.audit_from_seq !== expectedFrom || manifest.audit_to_seq !== expectedTo) {
        findings.push({
          path: MANIFEST_PATH,
          problem: 'manifest_mismatch',
          detail: 'audit range must equal first and last sequence in exported audit rows',
        });
      }
    } catch (error: unknown) {
      findings.push({
        path: 'audit-events.json',
        problem: 'manifest_mismatch',
        detail: `audit rows cannot establish exact decimal range: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const path of listedPaths) {
    if (CHECKPOINT_PUBLIC_KEY_EXPORT_PATH.exec(path) === null) continue;
    const checkpointFile = filesByPath.get(path);
    if (checkpointFile === undefined) continue;
    const problem = checkpointPublicKeyProblem(path, checkpointFile.content);
    if (problem !== undefined) {
      findings.push({ path, problem: 'manifest_mismatch', detail: problem });
    }
  }
  return findings;
}
