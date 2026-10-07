/** Shared current-claim reading: proof first, payloads only when the requested reading needs them. */
import type { Tx } from '@kf/database';
import { coveringGrants, enumerateAccessCoverage } from '@kf/authorization';
import {
  claimMemberCount,
  claimMembers,
  latestMasterRecordClaim,
  masterRecordById,
  masterRecordCurrency,
  type ClaimCurrency,
  type MasterRecordClaim,
  type MasterRecordManifest,
} from '@kf/documents';
import { recordVerification, type RecordVerification } from '@kf/domain';
import {
  assertMemberBudget,
  bindParameters,
  type ProjectionCorpus,
  type ProjectionParameterValue,
} from '@kf/projections';
import type { ProjectionDefinition } from '@kf/ontology-compiler';
import { liveVerifications, projectionMembersOf } from './master-record-members.js';

interface Reader {
  readonly actorId: string;
  readonly organizationId: string;
}
type Refusal =
  | { readonly status: 'missing' }
  | { readonly status: 'stale'; readonly currentCorpusDigest: string };
type Current = {
  readonly status: 'current';
  readonly claim: MasterRecordClaim;
  readonly currency: Extract<ClaimCurrency, { current: true }>;
};

async function current(tx: Tx, reader: Reader): Promise<Refusal | Current> {
  const claim = await latestMasterRecordClaim(tx, reader.actorId, reader.organizationId);
  if (claim === undefined) return { status: 'missing' };
  const currency = await masterRecordCurrency(
    tx,
    { personId: reader.actorId, organizationId: reader.organizationId },
    claim,
  );
  return currency.current
    ? { status: 'current', claim, currency }
    : { status: 'stale', currentCorpusDigest: currency.currentCorpusDigest };
}

/** Live labels without recomputing content payloads/digests for the whole permission set. */
async function verifications(
  tx: Tx,
  reader: Reader,
  ids: readonly string[],
): Promise<ReadonlyMap<string, RecordVerification>> {
  if (ids.length === 0) return new Map();
  const coverage = await enumerateAccessCoverage(tx, reader.actorId, reader.organizationId);
  const rows = await tx.query<{
    id: string;
    classification: string;
    basis: 'reviewed_individually' | 'promoted_in_bulk' | 'verified_by_policy' | null;
    verified_at: Date | null;
    verified_by: string | null;
    policy_id: string | null;
  }>(
    `select /* master-record.live-verification */ o.id, o.classification, v.basis, v.verified_at, v.verified_by, v.policy_id
       from core.object o left join core.object_verification v on v.object_id = o.id
      where o.organization_id = $1 and o.id = any($2::uuid[])`,
    [reader.organizationId, [...ids]],
  );
  return new Map(
    rows
      .filter((row) => coveringGrants(coverage, row.id, row.classification).length > 0)
      .map((row) => [
        row.id,
        recordVerification(
          row.basis === null || row.verified_at === null || row.verified_by === null
            ? undefined
            : {
                basis: row.basis,
                verifiedAt: new Date(row.verified_at).toISOString(),
                verifiedBy: row.verified_by,
                policyId: row.policy_id,
              },
        ),
      ]),
  );
}

/** The full-record wire contract includes its manifest: read it once, only after currency passes. */
export async function readCurrentMasterRecord(
  tx: Tx,
  reader: Reader,
): Promise<
  | Refusal
  | {
      readonly status: 'ready';
      readonly record: Record<string, unknown>;
      readonly manifest: MasterRecordManifest;
      readonly verifications: ReadonlyMap<string, RecordVerification>;
    }
> {
  const reading = await current(tx, reader);
  if (reading.status !== 'current') return reading;
  const record = await masterRecordById(tx, reading.claim.id);
  if (record === undefined) return { status: 'missing' };
  const manifest = record['manifest'] as MasterRecordManifest;
  const included = Array.isArray(manifest.included) ? manifest.included : [];
  return {
    status: 'ready',
    record,
    manifest,
    verifications:
      reading.currency.permitted === undefined
        ? await verifications(
            tx,
            reader,
            included.map((member) => member.objectId),
          )
        : liveVerifications(reading.currency.permitted),
  };
}

/** A whole-corpus projection consumes validated items, refusing its budget before payload reads. */
export async function readCurrentProjectionCorpus(
  tx: Tx,
  reader: Reader,
  definition: ProjectionDefinition,
  parameters: Readonly<Record<string, ProjectionParameterValue>> = {},
): Promise<
  | Refusal
  | {
      readonly status: 'ready';
      readonly corpus: ProjectionCorpus;
    }
> {
  const reading = await current(tx, reader);
  if (reading.status !== 'current') return reading;
  // Preserve the engine's parameter-refusal precedence before a large-corpus budget refusal.
  bindParameters(definition, parameters);
  assertMemberBudget(
    definition,
    await claimMemberCount(tx, reading.claim, reading.currency.members),
  );
  const members = await claimMembers(tx, reading.claim, reading.currency.members);
  const labels =
    reading.currency.permitted === undefined
      ? await verifications(
          tx,
          reader,
          members.included.map((member) => member.objectId),
        )
      : liveVerifications(reading.currency.permitted);
  return {
    status: 'ready',
    corpus: {
      personId: reader.actorId,
      organizationId: reader.organizationId,
      corpusDigest: reading.claim.corpusDigest,
      members: projectionMembersOf(members, labels),
    },
  };
}
