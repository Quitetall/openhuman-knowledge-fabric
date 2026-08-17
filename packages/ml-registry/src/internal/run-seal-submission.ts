import {
  assertExactKeys,
  checkedEd25519Signature,
  checkedOrganizationId,
  checkedSha256,
  checkedTimestamp,
  reject,
} from './validation.js';

const WORKLOAD_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/u;
const SIGNING_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const INPUT_KEYS = [
  'organizationId',
  'runLineageId',
  'workloadIdentityRef',
  'sealedAt',
  'signingKeyId',
  'sealDigest',
  'signature',
] as const;

export interface ExternallySignedRunSealSubmission {
  readonly organizationId: string;
  readonly runLineageId: string;
  readonly workloadIdentityRef: string;
  readonly sealedAt: string;
  readonly signingKeyId: string;
  readonly sealDigest: string;
  readonly signature: string;
}

export interface RunSealSubmissionReceipt {
  readonly id: string;
  readonly sealDigest: string;
  readonly signingKeyRegistryId: string;
}

/** Minimal transaction seam implemented by @kf/database Tx and simple offline controllers. */
export interface RunSealSubmissionDatabase {
  one<T>(sql: string, values: readonly unknown[]): Promise<T>;
}

interface SubmissionRow {
  readonly id: unknown;
  readonly seal_sha256: unknown;
  readonly signing_key_registry_id: unknown;
}

function checkedToken(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) reject(`${field} is not a safe token`);
  return value;
}

/**
 * Submit an externally produced Ed25519 signature to the privileged database verifier.
 *
 * This adapter never receives private key material and never signs. The database procedure
 * reconstructs the exact canonical lineage, segment, event-manifest, and run-seal bytes before
 * it verifies the registered public key and appends the immutable receipt.
 */
export async function submitExternallySignedRunSeal(
  database: RunSealSubmissionDatabase,
  input: ExternallySignedRunSealSubmission,
): Promise<RunSealSubmissionReceipt> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('run seal submission must be an object');
  }
  assertExactKeys(input, INPUT_KEYS, 'run seal submission');
  const organizationId = checkedOrganizationId(input.organizationId, 'organizationId');
  const runLineageId = checkedOrganizationId(input.runLineageId, 'runLineageId');
  const workloadIdentityRef = checkedToken(
    input.workloadIdentityRef,
    'workloadIdentityRef',
    WORKLOAD_IDENTITY,
  );
  const sealedAt = checkedTimestamp(input.sealedAt, 'sealedAt');
  const signingKeyId = checkedToken(input.signingKeyId, 'signingKeyId', SIGNING_KEY_ID);
  const sealDigest = checkedSha256(input.sealDigest, 'sealDigest');
  checkedEd25519Signature(input.signature, 'signature');

  const row = await database.one<SubmissionRow>(
    `select id, seal_sha256, signing_key_registry_id
       from ml.append_signed_run_seal(
         $1::uuid, $2::uuid, $3::text, $4::timestamptz, $5::text, $6::text, $7::text
       )`,
    [
      organizationId,
      runLineageId,
      workloadIdentityRef,
      sealedAt,
      signingKeyId,
      sealDigest,
      input.signature,
    ],
  );
  return Object.freeze({
    id: checkedOrganizationId(row.id, 'receipt.id'),
    sealDigest: checkedSha256(row.seal_sha256, 'receipt.sealDigest'),
    signingKeyRegistryId: checkedOrganizationId(
      row.signing_key_registry_id,
      'receipt.signingKeyRegistryId',
    ),
  });
}
