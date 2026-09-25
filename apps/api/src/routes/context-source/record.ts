/**
 * What a context source reads, and how it is recorded (KF-SAS-RQ-115, RQ-219, §59, §64B).
 *
 * The routes in `../context-source.ts` answer LAMU's context compiler. Everything they decide is
 * decided here, inside a transaction the caller has already bound as the person:
 *
 *   - which records the person's agent context holds NOW (`agentContextCorpus`): the live permitted
 *     set, and whether their latest master record still claims exactly it. `agent_context`'s sections
 *     cover the corpus with a remainder (§59), so a record is a member of that projection's `included`
 *     members exactly when it is a member of the claim — and, while the claim is current, exactly when
 *     it is in the live permitted set. The corpus digest an answer is bound to is that claim's.
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
  assertPermissionSetInvariant,
  enumeratePermittedSet,
  latestMasterRecord,
  masterRecordMemberFormat,
  type MasterRecordManifest,
  type PermissionMember,
} from '@kf/documents';
import {
  DocumentBytesUnavailable,
  documentSourceBytes,
  type StoredDocumentBytes,
} from '../documents/source-bytes.js';

export const CONTEXT_SOURCE_ADAPTER = 'knowledge-fabric';
export const CONTEXT_SOURCE_RECORD_SCHEMA = 'kf.context-source-record/v1';
export const CONTEXT_FACTS_SCHEMA = 'kf.context-facts/v1';
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

export type AgentContextCorpus =
  | {
      readonly status: 'current';
      readonly corpusDigest: string;
      /** The claim's included members, which are the live permitted set. */
      readonly members: ReadonlyMap<string, PermissionMember>;
    }
  | {
      readonly status: 'master_record_stale' | 'master_record_not_found';
      /** The live permitted set, which no current claim describes. */
      readonly members: ReadonlyMap<string, PermissionMember>;
    };

/**
 * The corpus the person's `agent_context` projection is evaluated over, checked against current
 * authority exactly as `GET /master-record/projections/agent_context` checks it. The session must be
 * bound as `reader`.
 */
export async function agentContextCorpus(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
): Promise<AgentContextCorpus> {
  const record = await latestMasterRecord(tx, reader.actorId, reader.organizationId);
  const manifest = record?.['manifest'] as MasterRecordManifest | undefined;
  // A stored claim is re-checked under the member format it recorded; with none, the current one.
  const permitted =
    manifest === undefined
      ? await enumeratePermittedSet(tx, reader.actorId, reader.organizationId)
      : await enumeratePermittedSet(
          tx,
          reader.actorId,
          reader.organizationId,
          masterRecordMemberFormat(manifest),
        );
  const members = new Map(permitted.map((member) => [member.objectId, member]));
  if (record === undefined || manifest === undefined) {
    return { status: 'master_record_not_found', members };
  }
  const corpusDigest = String(record['corpus_digest']);
  try {
    assertPermissionSetInvariant(
      {
        corpusDigest,
        included: Array.isArray(manifest.included) ? manifest.included : [],
        withdrawn: Array.isArray(manifest.withdrawn) ? manifest.withdrawn : [],
      },
      permitted,
    );
  } catch {
    return { status: 'master_record_stale', members };
  }
  return { status: 'current', corpusDigest, members };
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

/** A record's facts as the master record carries them, canonical so the bytes never vary. */
export function contextFacts(member: PermissionMember): string {
  return canonicalize({
    schema: CONTEXT_FACTS_SCHEMA,
    objectId: member.objectId,
    objectType: member.objectType,
    classification: member.classification,
    title: member.title ?? '',
    content: member.content ?? {},
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
  readonly operation: 'retrieve' | 'read';
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
