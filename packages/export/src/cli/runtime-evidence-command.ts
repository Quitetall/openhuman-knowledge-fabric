import { readArchiveRuntimeBinding } from '../archive-runtime-binding.js';
import { isRecord } from '../internal/format.js';
import { canonicalize } from '@kf/canonicalization';
import { readWarrantRuntimeEvidence } from '../warrant-runtime-evidence.js';
import type { CliArguments } from './arguments.js';
import { configured, required } from './configuration.js';
import { loadTrustStore, readBoundedRegularFile, readPackage } from './package-io.js';

/** Offline, read-only bridge for callers that do not embed the TypeScript SDK. */
export function runtimeEvidenceCommand(args: CliArguments, dir: string): number {
  if (
    args.allowUnsignedLegacyV1 ||
    args.signingKeyPath !== undefined ||
    args.signingKeyId !== undefined ||
    args.checkpointPublicKeyDir !== undefined ||
    args.snapshotToken !== undefined ||
    args.stageDirectory !== undefined
  )
    throw new Error(
      'runtime-evidence accepts only trust-store, warrant-id, dispatch-file and archive-basis options',
    );
  const warrantId = required(args.warrantId, 'runtime-evidence requires --warrant-id');
  const keys = loadTrustStore(
    required(
      configured(args.trustStoreDir, 'PRESERVATION_TRUST_STORE_DIR'),
      'runtime-evidence requires --trust-store or PRESERVATION_TRUST_STORE_DIR',
    ),
  );
  let remaining = 16 * 1024 * 1024;
  const packets: unknown[] = args.dispatchFiles.map((path) => {
    const bytes = readBoundedRegularFile(path, Math.min(remaining, 1024 * 1024), 'dispatch packet');
    remaining -= bytes.length;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  });
  const pkg = readPackage(dir);
  let evidence;
  if (args.archiveBasisFile === undefined) {
    evidence = readWarrantRuntimeEvidence(pkg, warrantId, keys, packets);
  } else {
    const bytes = readBoundedRegularFile(args.archiveBasisFile, 1024 * 1024, 'archive basis');
    const basis: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(basis) || basis['warrant_id'] !== warrantId) {
      throw new Error('Archive basis does not match requested Warrant');
    }
    evidence = readArchiveRuntimeBinding(pkg, basis, keys, packets);
  }
  process.stdout.write(`${canonicalize(evidence)}\n`);
  return 0;
}
