import { runtimeContractIdentity } from './runtime-contract-identity.js';
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
  readonly stageBindings: readonly Row[];
  readonly unmappedDispatchDigests: readonly string[];
  /** No retained receipt row; this does not establish whether execution occurred. */
  readonly dispatchesWithoutReceipts: readonly string[];
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
  dispatchPackets: readonly unknown[] = [],
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
  const receiptedDispatches = new Set<string>();
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
    receiptedDispatches.add(row['dispatch_digest']);
  }
  const stageBindings: Row[] = [];
  const mapped = new Set<string>();
  for (const packet of dispatchPackets) {
    if (
      !isRecord(packet) ||
      packet['api_version'] !== 'oh.war/stage-dispatch/v1' ||
      packet['warrant_ref'] !== `war://${warrantId}` ||
      typeof packet['stage_id'] !== 'string' ||
      packet['stage_id'].trim() === '' ||
      typeof packet['milestone_id'] !== 'string' ||
      packet['milestone_id'].trim() === '' ||
      typeof packet['attempt_id'] !== 'string' ||
      packet['attempt_id'].trim() === '' ||
      typeof packet['dispatch_id'] !== 'string' ||
      packet['dispatch_id'].trim() === '' ||
      typeof packet['dispatch_digest'] !== 'string'
    )
      throw new Error('Invalid runtime stage dispatch packet');
    const packetDigest = packet['dispatch_digest'];
    const computed = digest({
      digest_domain: 'oh.war/dispatch/v1',
      payload: { ...packet, dispatch_digest: '' },
    });
    const dispatch = dispatches.find((row) => row['dispatch_digest'] === packetDigest);
    const contract = contracts.find(
      (row) => row['revision_no'] === dispatch?.['authorized_revision'],
    );
    const sourceContract =
      contract === undefined ? undefined : runtimeContractIdentity(contract, warrantId);
    if (
      computed !== packetDigest ||
      mapped.has(packetDigest) ||
      dispatch === undefined ||
      contract === undefined ||
      sourceContract === undefined ||
      sourceContract.revision !== packet['contract_revision'] ||
      sourceContract.digest !== packet['contract_digest']
    )
      throw new Error('Runtime stage packet digest or contract binding mismatch');
    mapped.add(packetDigest);
    stageBindings.push({ ...packet });
  }
  return {
    manifestDigest: digest(pkg.manifest),
    databaseSnapshotDigest: snapshot,
    warrant,
    contracts,
    dispatches,
    receipts,
    stageBindings,
    unmappedDispatchDigests: [...dispatchDigests].filter((value) => !mapped.has(value)).sort(),
    dispatchesWithoutReceipts: [...dispatchDigests]
      .filter((value) => !receiptedDispatches.has(value))
      .sort(),
  };
}
