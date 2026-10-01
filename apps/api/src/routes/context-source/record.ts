/**
 * What a context source reads, and how it is recorded (KF-SAS-RQ-115, RQ-219, §59, §64B).
 *
 * The routes in `../context-source.ts` answer LAMU's context compiler. Everything they decide is
 * decided here, inside a transaction the caller has already bound as the person:
 *
 *   - whether the person may read a record NOW (`permittedAmong`): the master record's own
 *     definition of the permitted set, applied to the records in question rather than the whole
 *     organization, so every call re-checks current authority without enumerating the corpus.
 *   - whether the record is in their agent_context at that revision (`latestClaim`,
 *     `claimedRevisions`): their latest master record included it at that member digest.
 *     `agent_context`'s sections cover the corpus with a remainder (§59), so its `included` members
 *     are exactly the claim's. The corpus digest an answer is bound to is that claim's.
 *   - what the text of a record is (`describeText`): the verified bytes of its source when the source
 *     is text, otherwise its facts as the master record carries them, canonicalized.
 *   - whether the person was ever told a record exists (`onceIncluded`): one of their own master
 *     records included it. That, and only that, turns a refusal from 404 into 403.
 *   - the record of each answer and refusal (`recordContextDisclosure`), through a definer seam that
 *     takes who, where and which agent from the sealed context.
 *
 * Nothing here keeps text: not in memory past the request, not in a table, not in a log line.
 */

import { canonicalize, digestBytes, taggedDigest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import {
  enumeratePermittedSet,
  masterRecordMemberFormat,
  type MasterRecordMemberFormat,
  type PermissionMember,
} from '@kf/documents';
import {
  DocumentBytesUnavailable,
  documentSourceBytes,
  type StoredDocumentBytes,
} from '../documents/source-bytes.js';

export const CONTEXT_SOURCE_ADAPTER = 'knowledge-fabric';
export const CONTEXT_SOURCE_RECORD_SCHEMA = 'kf.context-source-record/v1';
export const CONTEXT_FACTS_SCHEMA = 'kf.context-facts/v2';
/** The digest of a retrieval's reference list, as recorded. */
export const REFERENCES_DIGEST_FORMAT = 'kf-context-source-references-v1';
/**
 * The largest text a read returns, in UTF-8 bytes. LAMU's adapter refuses more
 * (`context_kf.rs`: `record.text.len() > 1024 * 1024`), so serving it would disclose text the
 * consumer then drops.
 */
export const MAX_CONTEXT_TEXT_BYTES = 1024 * 1024;
/** The largest response body LAMU's adapter reads (`MAX_RESPONSE`). */
export const MAX_CONTEXT_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Media types whose bytes are the record's text. Everything else is read as its facts. */
const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown']);

/**
 * The refusal vocabulary of the context source. Each is recorded before it is answered.
 *
 * KF-CTX-001 is the only answer for a record the caller was never told about — absent, in another
 * organization, above their ceiling, or never granted — and it names nothing, in the response or
 * in the record of it. KF-CTX-002 is reserved for a record one of the caller's own master records
 * included, so it confirms only what KF already disclosed to them.
 */
export const CONTEXT_REFUSALS = {
  not_found: { rule: 'KF-CTX-001', status: 404 },
  grant_withdrawn: { rule: 'KF-CTX-002', status: 403 },
  revision_mismatch: { rule: 'KF-CTX-003', status: 409 },
  master_record_stale: { rule: 'KF-CTX-004', status: 409 },
  master_record_not_found: { rule: 'KF-CTX-005', status: 409 },
  semantic_ranking_unavailable: { rule: 'KF-CTX-006', status: 503 },
  source_text_unavailable: { rule: 'KF-CTX-007', status: 503 },
} as const;

export type ContextRefusal = keyof typeof CONTEXT_REFUSALS;

export interface SourceReference {
  readonly adapter: typeof CONTEXT_SOURCE_ADAPTER;
  readonly record: string;
  readonly revision: string;
  readonly digest: string;
}

/** Exactly the fields LAMU's adapter accepts (`deny_unknown_fields`), and no others. */
export interface ContextSourceRecord {
  readonly schema: typeof CONTEXT_SOURCE_RECORD_SCHEMA;
  readonly source: SourceReference;
  readonly text: string;
  readonly classification: string;
  readonly trust: 'untrusted';
  readonly localOnly: true;
  readonly retention: 'ephemeral';
}

/** What `POST /context-source/revision` answers: the SourceRef's revision and digest, no text. */
export interface ContextSourceRevision {
  readonly revision: string;
  readonly digest: string;
}

/**
 * The claim the person's `agent_context` projection is evaluated over: their latest master record
 * visible at the bound ceiling, as `GET /master-record/projections/agent_context` selects it. Its
 * corpus digest is what every answer is bound to; the manifest is not read.
 */
export interface AgentContextClaim {
  readonly id: string;
  readonly corpusDigest: string;
  readonly memberFormat: MasterRecordMemberFormat;
}

export async function latestClaim(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
): Promise<AgentContextClaim | undefined> {
  const row = await tx.maybeOne<{ id: string; corpus_digest: string; format: string | null }>(
    `select /* context-source.latest-claim */
            id, corpus_digest, manifest_format as format
       from content.master_record
      where person_id = $1 and organization_id = $2
      order by compiled_at desc, recorded_at desc, id desc
      limit 1`,
    [reader.actorId, reader.organizationId],
  );
  if (row === undefined) return undefined;
  return {
    id: row.id,
    corpusDigest: row.corpus_digest,
    memberFormat: masterRecordMemberFormat({ format: row.format }),
  };
}

/**
 * The live permitted members among `ids`: the master record's own definition of what the person
 * may read now (row security, grants, entitlement exclusions, retention holds), applied to these
 * records only, with each member's digest under the claim's member format.
 */
export async function permittedAmong(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
  memberFormat: MasterRecordMemberFormat,
  ids: readonly string[],
): Promise<ReadonlyMap<string, PermissionMember>> {
  if (ids.length === 0) return new Map();
  const members = await enumeratePermittedSet(
    tx,
    reader.actorId,
    reader.organizationId,
    memberFormat,
    ids,
  );
  return new Map(members.map((member) => [member.objectId, member]));
}

/**
 * The revision at which the claim included each of `ids`. A record is in the person's
 * agent_context at a revision exactly when their claim included it at that member digest:
 * `agent_context`'s sections cover the corpus with a remainder (§59), so its `included` members
 * are the claim's.
 */
export async function claimedRevisions(
  tx: Tx,
  claim: AgentContextClaim,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ object_id: string; content_digest: string }>(
    `select /* context-source.claimed-revisions */ object_id, content_digest
       from content.master_record_item
      where master_record_id = $1
        and object_id = any($2::uuid[])
        and item_state = 'included'`,
    [claim.id, [...ids]],
  );
  return new Map(rows.map((row) => [row.object_id, row.content_digest]));
}

/**
 * Whether one of the reader's own master records, visible to them now, included the record: the
 * only evidence this system accepts that the reader was once told it exists.
 */
export async function onceIncluded(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
  objectId: string,
): Promise<boolean> {
  const row = await tx.one<{ included: boolean }>(
    `select /* context-source.once-included */ exists (
       select 1
         from content.master_record m
         join content.master_record_item i on i.master_record_id = m.id
        where m.person_id = $1
          and m.organization_id = $2
          and i.object_id = $3
          and i.item_state = 'included'
     ) as included`,
    [reader.actorId, reader.organizationId, objectId],
  );
  return row.included;
}

export type ContextText =
  | {
      readonly kind: 'source';
      readonly digest: string;
      readonly oversize: boolean;
      readonly source: StoredDocumentBytes;
    }
  | {
      readonly kind: 'facts';
      readonly digest: string;
      readonly oversize: boolean;
      readonly text: string;
    };

function mediaTypeOf(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

/** The envelope fields that say what a record is; the rest are bookkeeping or authority. */
const ENVELOPE_FACTS = ['enterprise_id', 'lifecycle_state', 'created_at', 'updated_at'] as const;
/** What a version of a file is, without where it is stored or who stored it. */
const VERSION_FACTS = [
  'version_no',
  'revision_label',
  'media_type',
  'size_bytes',
  'sha256',
  'created_at',
] as const;

function pick(
  row: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * A record's facts: what the record says, and nothing about who may see it or why.
 *
 * The master-record payload the facts are taken from is built for IDENTITY, not disclosure: it
 * carries every row that references the record — its access grants with their reasons, the
 * identity links a person made for others, observations and derivation links of OTHER records
 * (whose own grants were never asked) — plus bookkeeping (who wrote each row, row and schema
 * versions, retention class, the object-store key of every version). `kf.context-facts/v1` served
 * all of it. v2 serves, from that payload:
 *
 *   - the envelope's title, type, classification, lifecycle state, enterprise id and times;
 *   - the record's own typed rows (`schema.table`, one per extension table), without their `id`;
 *   - of each file version, its number, label, media type, size, SHA-256 and time.
 *
 * Never a referencing collection (`schema.table.column`), a locator or relationship list, or an
 * envelope field outside the list above.
 *
 * The digest covers exactly this text. The REVISION is still the member digest, which covers the
 * whole payload, grants included: a grant change moves the revision and not the text, and a
 * SourceRef taken before it is answered 409 KF-CTX-003 like any other move, so the caller
 * re-retrieves (and, if the claim no longer matches, recompiles) under the authority that holds now.
 */
export function contextFacts(member: PermissionMember): string {
  const payload = member.content ?? {};
  const envelope = pick(payload['core.object'], ENVELOPE_FACTS) ?? {};
  const records: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'core.object' || key.split('.').length !== 2) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const { id: _id, ...row } = value as Record<string, unknown>;
    records[key] = row;
  }
  const versions = Array.isArray(payload['content.artifact_version'])
    ? (payload['content.artifact_version'] as unknown[])
        .map((version) => pick(version, VERSION_FACTS))
        .filter((version) => version !== undefined)
    : [];
  return canonicalize({
    schema: CONTEXT_FACTS_SCHEMA,
    objectId: member.objectId,
    objectType: member.objectType,
    classification: member.classification,
    title: member.title ?? '',
    ...envelope,
    records,
    ...(versions.length === 0 ? {} : { versions }),
  });
}

/**
 * What `read` will return for a member, without reading any bytes yet.
 *
 * A record whose source is text is its source: the digest is the SHA-256 the artifact version
 * records, which is inside the member digest (the revision), so the text is bound to the revision
 * and verified against it when read. Any other record is its facts.
 */
export async function describeText(tx: Tx, member: PermissionMember): Promise<ContextText> {
  let source: StoredDocumentBytes | undefined;
  try {
    source = await documentSourceBytes(tx, member.objectId, Number.MAX_SAFE_INTEGER);
  } catch (error: unknown) {
    // A source whose storage identity is incomplete has no bytes anyone may be served; the record
    // is read as its facts, which name exactly that.
    if (!(error instanceof DocumentBytesUnavailable)) throw error;
    source = undefined;
  }
  if (source !== undefined && TEXT_MEDIA_TYPES.has(mediaTypeOf(source.mediaType))) {
    return {
      kind: 'source',
      digest: source.sha256,
      oversize: source.sizeBytes > MAX_CONTEXT_TEXT_BYTES,
      source,
    };
  }
  const text = contextFacts(member);
  const bytes = Buffer.from(text, 'utf8');
  return {
    kind: 'facts',
    digest: digestBytes(bytes),
    oversize: bytes.byteLength > MAX_CONTEXT_TEXT_BYTES,
    text,
  };
}

/** The text of verified source bytes, or undefined when they are not UTF-8. */
export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    // `ignoreBOM` keeps a byte-order mark as text, so the string encodes back to the same bytes.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function referenceOf(member: PermissionMember, digest: string): SourceReference {
  return {
    adapter: CONTEXT_SOURCE_ADAPTER,
    record: member.objectId,
    revision: member.contentDigest,
    digest,
  };
}

export function referencesDigest(references: readonly SourceReference[]): string {
  return taggedDigest(REFERENCES_DIGEST_FORMAT, {
    references: references.map((reference) => ({ ...reference })),
  });
}

export interface ContextDisclosure {
  readonly operation: 'retrieve' | 'read' | 'revision';
  readonly refusal?: ContextRefusal | undefined;
  readonly corpusDigest?: string | undefined;
  readonly objectId?: string | undefined;
  readonly revision?: string | undefined;
  readonly textDigest?: string | undefined;
  readonly referencesDigest?: string | undefined;
  readonly referenceCount?: number | undefined;
  readonly omittedCount?: number | undefined;
}

/**
 * Record one answer or refusal in the bound transaction (`search.record_context_disclosure`). The
 * answer is sent only after this commits: a disclosure that could not be recorded is not made.
 */
export async function recordContextDisclosure(tx: Tx, entry: ContextDisclosure): Promise<string> {
  const row = await tx.one<{ id: string }>(
    'select search.record_context_disclosure($1, $2, $3, $4, $5, $6, $7, $8, $9) as id',
    [
      entry.operation,
      entry.refusal === undefined ? null : CONTEXT_REFUSALS[entry.refusal].rule,
      entry.corpusDigest ?? null,
      entry.objectId ?? null,
      entry.revision ?? null,
      entry.textDigest ?? null,
      entry.referencesDigest ?? null,
      entry.referenceCount ?? null,
      entry.omittedCount ?? null,
    ],
  );
  return row.id;
}
