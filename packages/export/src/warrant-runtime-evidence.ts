import type { KeyObject } from 'node:crypto';
import { digest } from '@kf/canonicalization';
import { isRecord } from './internal/format.js';
import type { ExportPackage } from './internal/types.js';
import { verifyExport } from './internal/verifier.js';

type Row = Readonly<Record<string, unknown>>;

export interface WarrantRuntimeEvidence {
  readonly manifestDigest: string;
  readonly databaseSnapshotDigest: string;
  readonly warrant: Row;
  readonly contracts: readonly Row[];
  readonly dispatches: readonly Row[];
  readonly receipts: readonly Row[];
}

/**
 * Read provider-owned runtime records from an authenticated offline snapshot.
 * Returned rows preserve all columns, including historical attempts and native
 * receipt bodies. This checks relational bindings, not runtime success, actor
 * authorization, receipt semantics or stage coverage. It activates no authority.
 * Retain the original package and trust configuration alongside this projection.
 */
export function readWarrantRuntimeEvidence(
  pkg: ExportPackage,
  warrantId: string,
  trustedManifestKeys: ReadonlyMap<string, KeyObject>,
): WarrantRuntimeEvidence {
  const findings = verifyExport(pkg, { trustedManifestKeys });
  if (findings.length > 0) {
    throw new Error(
      `Runtime evidence package refused: ${findings.map((f) => f.problem).join(', ')}`,
    );
  }
  const snapshot = pkg.manifest.database_snapshot_sha256;
  if (pkg.manifest.format_version !== '2' || typeof snapshot !== 'string') {
    throw new Error('Runtime evidence requires an authenticated v2 database snapshot');
  }
  const rows = (section: string): Row[] => {
    const file = pkg.files.find((entry) => entry.path === `${section}.json`);
    if (file === undefined) throw new Error(`Missing runtime evidence section: ${section}`);
    const value: unknown = JSON.parse(file.content);
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw new Error(`Invalid runtime evidence rows: ${section}`);
    }
    return value;
  };
  const warrants = rows('warrants').filter((row) => row['id'] === warrantId);
  const warrant = warrants[0];
  if (warrants.length !== 1 || warrant === undefined) {
    throw new Error('Runtime evidence requires exactly one matching Warrant');
  }
  const selected = (section: string) =>
    rows(section).filter((row) => row['warrant_id'] === warrantId);
  const contracts = selected('warrant-contract-revisions');
  const dispatches = selected('warrant-dispatches');
  const receipts = selected('warrant-runtime-receipts');
  const revisions = new Set<unknown>();
  for (const row of contracts) {
    const revision = row['revision_no'];
    if (!Number.isSafeInteger(revision) || Number(revision) < 1 || revisions.has(revision)) {
      throw new Error('Invalid or duplicate runtime contract revision');
    }
    revisions.add(revision);
  }
  const dispatchDigests = new Set<string>();
  for (const row of dispatches) {
    const value = row['dispatch_digest'];
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value) ||
      dispatchDigests.has(value) ||
      !revisions.has(row['authorized_revision'])
    ) {
      throw new Error('Runtime dispatch has invalid contract binding or duplicate digest');
    }
    dispatchDigests.add(value);
  }
  const receiptDigests = new Set<string>();
  for (const row of receipts) {
    const value = row['receipt_digest'];
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value) ||
      receiptDigests.has(value) ||
      typeof row['dispatch_digest'] !== 'string' ||
      !dispatchDigests.has(row['dispatch_digest'])
    ) {
      throw new Error('Runtime receipt has invalid dispatch binding or duplicate digest');
    }
    receiptDigests.add(value);
  }
  return {
    manifestDigest: digest(pkg.manifest),
    databaseSnapshotDigest: snapshot,
    warrant,
    contracts,
    dispatches,
    receipts,
  };
}
