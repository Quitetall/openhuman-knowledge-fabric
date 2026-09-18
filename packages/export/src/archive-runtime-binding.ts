import { runtimeContractIdentity } from './runtime-contract-identity.js';
import { bindArchiveStages } from './archive-stage-binding.js';
import type { KeyObject } from 'node:crypto';
import { isRecord } from './internal/format.js';
import type { ExportPackage } from './internal/types.js';
import { readWarrantRuntimeEvidence } from './warrant-runtime-evidence.js';

type Contract = { revision: number; digest: string };

function contract(value: unknown): Contract {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value['revision']) ||
    Number(value['revision']) < 1 ||
    typeof value['digest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['digest'])
  )
    throw new Error('Invalid archive contract identity');
  return { revision: Number(value['revision']), digest: value['digest'] };
}

/**
 * Compare a source-derived OpenWarrant query basis with authenticated provider rows.
 * The caller must reconstruct the basis with `war archive runtime-basis`; this
 * function validates its shape, not the source archive or its authority. Equality
 * requires both revision and digest. Missing records remain explicit. No result
 * of this function establishes runtime success, stage coverage or qualification.
 */
export function readArchiveRuntimeBinding(
  pkg: ExportPackage,
  basis: unknown,
  trustedManifestKeys: ReadonlyMap<string, KeyObject>,
  dispatchPackets: readonly unknown[] = [],
) {
  if (
    !isRecord(basis) ||
    basis['schema'] !== 'oh.war/runtime-archive-basis/v1-draft.1' ||
    typeof basis['warrant_id'] !== 'string' ||
    basis['warrant_id'].trim() === '' ||
    basis['subject'] !== `war://${basis['warrant_id']}` ||
    typeof basis['archive_digest'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(basis['archive_digest']) ||
    !Array.isArray(basis['retained_contracts']) ||
    basis['retained_contracts'].length > 10000 ||
    basis['authority_activated'] !== false ||
    basis['qualified'] !== false
  )
    throw new Error('Invalid archive runtime basis');
  const current = contract(basis['current_contract']);
  const sourceContracts = new Map<number, string>();
  for (const item of [current, ...basis['retained_contracts'].map(contract)]) {
    const previous = sourceContracts.get(item.revision);
    if (previous !== undefined && previous !== item.digest) {
      throw new Error('Conflicting archive contract identities for one revision');
    }
    sourceContracts.set(item.revision, item.digest);
  }
  const evidence = readWarrantRuntimeEvidence(
    pkg,
    basis['warrant_id'],
    trustedManifestKeys,
    dispatchPackets,
  );
  const matched = new Map<number, string>();
  const providerContractsWithoutSource: {
    revision: number;
    digest: string;
    providerRevision: number;
  }[] = [];
  const providerContractsWithoutSourceIdentity: { providerRevision: number; reason: string }[] = [];
  const providerContractBindings: {
    providerRevision: number;
    sourceRevision: number;
    digest: string;
    matched: boolean;
  }[] = [];
  const providerRevisions = new Set<number>();
  for (const row of [...evidence.contracts].sort(
    (a, b) => Number(a['revision_no']) - Number(b['revision_no']),
  )) {
    const providerRevision = Number(row['revision_no']);
    const item = runtimeContractIdentity(row, basis['warrant_id']);
    if (item === undefined) {
      providerContractsWithoutSourceIdentity.push({
        providerRevision,
        reason: 'retained canonical IR has no supported source contract identity',
      });
      continue;
    }
    providerRevisions.add(item.revision);
    const expected = sourceContracts.get(item.revision);
    if (expected === undefined) providerContractsWithoutSource.push({ ...item, providerRevision });
    else if (expected !== item.digest) {
      throw new Error(`Provider contract digest differs from archive revision ${item.revision}`);
    } else matched.set(item.revision, item.digest);
    providerContractBindings.push({
      providerRevision,
      sourceRevision: item.revision,
      digest: item.digest,
      matched: expected === item.digest,
    });
  }
  const matchedContracts = [...matched]
    .map(([revision, digest]) => ({ revision, digest }))
    .sort((a, b) => a.revision - b.revision);
  return {
    schema: 'kf.archive-runtime-binding/v1-draft.1',
    archiveDigest: basis['archive_digest'],
    sourceStageBindings: bindArchiveStages(
      basis['stage_inventory'],
      current.revision,
      evidence.stageBindings,
    ),
    sourceBasisAuthenticated: false,
    currentContractMatched: matchedContracts.some((item) => item.revision === current.revision),
    matchedContracts,
    providerContractsWithoutSource,
    providerContractsWithoutSourceIdentity,
    providerContractBindings,
    sourceContractsWithoutProvider: [...sourceContracts]
      .filter(([revision]) => !providerRevisions.has(revision))
      .map(([revision, digest]) => ({ revision, digest }))
      .sort((a, b) => a.revision - b.revision),
    authorityActivated: false,
    qualified: false,
    evidence,
  };
}
