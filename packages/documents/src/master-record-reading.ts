import type { Tx } from '@kf/database';
import {
  assertPermissionSetInvariant,
  corpusDigest,
  masterRecordMemberFormat,
  type MasterRecordClassification,
  type MasterRecordManifest,
  type MasterRecordMemberFormat,
  type PermissionMember,
  type RelationPolicy,
  type RelevanceEdge,
} from './master-record.js';
import { enumeratePermittedSet, enumerateRelationPolicies } from './master-record-repository.js';

/**
 * Reading ONE part of a master record: whether the claim is current, and its members among a few
 * records, without loading the manifest that lists every member with its payload.
 *
 * A manifest of a 50 000-member corpus is ~150 MB of JSON; `latestMasterRecord` selects it whole.
 * Everything here reads the claim's header, its item rows by key, and — only when needed — the
 * manifest entries of the few records asked about.
 */

/** A claim's header: identity and scope, no members. */
export interface MasterRecordClaim {
  readonly id: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly corpusDigest: string;
}

/** The latest claim, selected exactly as `latestMasterRecord` selects it, without its manifest. */
export async function latestMasterRecordClaim(
  tx: Tx,
  personId: string,
  organizationId: string,
): Promise<MasterRecordClaim | undefined> {
  const row = await tx.maybeOne<{
    id: string;
    person_id: string;
    organization_id: string;
    corpus_digest: string;
  }>(
    `select /* master-record.latest-claim */ id, person_id, organization_id, corpus_digest
       from content.master_record
      where person_id = $1 and organization_id = $2
      order by compiled_at desc, recorded_at desc, id desc
      limit 1`,
    [personId, organizationId],
  );
  return row === undefined
    ? undefined
    : {
        id: row.id,
        personId: row.person_id,
        organizationId: row.organization_id,
        corpusDigest: row.corpus_digest,
      };
}

/** Where a current claim's members are read from: its item rows, or (legacy) its manifest. */
export type ClaimMembersSource =
  | { readonly kind: 'items'; readonly manifestFormat: string }
  | {
      readonly kind: 'manifest';
      readonly included: readonly PermissionMember[];
      readonly withdrawn: readonly PermissionMember[];
    };

export type ClaimCurrency =
  | {
      readonly current: true;
      /** `recorded`: shown by the database's record of writes; `enumerated`: by comparing again. */
      readonly basis: 'recorded' | 'enumerated';
      readonly memberFormat: MasterRecordMemberFormat;
      readonly members: ClaimMembersSource;
      /** The whole permitted set, when it was enumerated to decide. */
      readonly permitted?: readonly PermissionMember[];
    }
  | { readonly current: false };

/**
 * Whether `claim` is still the reader's current corpus (ADR 0013: "stale means the corpus moved").
 *
 * First, without reading the corpus: `content.master_record_current_format` answers when the
 * reader's own compilation recorded the claim current and no input of the reading has been written
 * since by a transaction that compilation did not see (20260926110100). When it cannot show that,
 * the corpus is enumerated and compared, as it always was — against the claim's item rows when
 * they reproduce its recorded corpus digest (they are its manifest's members, held so by the
 * database), and against the manifest otherwise.
 */
export async function masterRecordCurrency(
  tx: Tx,
  reader: { readonly personId: string; readonly organizationId: string },
  claim: MasterRecordClaim,
): Promise<ClaimCurrency> {
  const recorded = await tx.one<{ format: string | null }>(
    'select /* master-record.current-format */ content.master_record_current_format($1) as format',
    [claim.id],
  );
  if (recorded.format !== null) {
    return {
      current: true,
      basis: 'recorded',
      memberFormat: masterRecordMemberFormat({ format: recorded.format }),
      members: { kind: 'items', manifestFormat: recorded.format },
    };
  }

  const { format } = await tx.one<{ format: string | null }>(
    `select /* master-record.format */ manifest ->> 'format' as format
       from content.master_record where id = $1`,
    [claim.id],
  );
  const memberFormat = masterRecordMemberFormat({ format });
  const permitted = await enumeratePermittedSet(
    tx,
    reader.personId,
    reader.organizationId,
    memberFormat,
  );
  const items = await claimItemCorpus(tx, claim);
  let members: ClaimMembersSource;
  let included: readonly PermissionMember[];
  let withdrawn: readonly PermissionMember[];
  if (corpusDigest(items.included, items.withdrawn) === claim.corpusDigest) {
    members = { kind: 'items', manifestFormat: String(format) };
    included = items.included;
    withdrawn = items.withdrawn;
  } else {
    const row = await tx.one<{ manifest: MasterRecordManifest }>(
      'select /* master-record.manifest */ manifest from content.master_record where id = $1',
      [claim.id],
    );
    included = Array.isArray(row.manifest.included) ? row.manifest.included : [];
    withdrawn = Array.isArray(row.manifest.withdrawn) ? row.manifest.withdrawn : [];
    members = { kind: 'manifest', included, withdrawn };
  }
  try {
    assertPermissionSetInvariant(
      { corpusDigest: claim.corpusDigest, included, withdrawn },
      permitted,
    );
  } catch {
    return { current: false };
  }
  return { current: true, basis: 'enumerated', memberFormat, members, permitted };
}

interface ItemRow extends Record<string, unknown> {
  readonly object_id: string;
  readonly object_type: string;
  readonly title: string;
  readonly classification: MasterRecordClassification;
  readonly content_digest: string;
  readonly item_state: 'included' | 'withdrawn';
}

/** A claim's members as its item rows record them: identity fields only, no payload. */
async function claimItemCorpus(
  tx: Tx,
  claim: MasterRecordClaim,
): Promise<{
  readonly included: readonly PermissionMember[];
  readonly withdrawn: readonly PermissionMember[];
}> {
  const rows = await tx.query<ItemRow>(
    `select /* master-record.item-corpus */
            object_id, object_type, title, classification, content_digest, item_state
       from content.master_record_item
      where master_record_id = $1`,
    [claim.id],
  );
  const member = (row: ItemRow): PermissionMember => ({
    objectId: row.object_id,
    objectType: row.object_type,
    organizationId: claim.organizationId,
    classification: row.classification,
    contentDigest: row.content_digest,
    title: row.title,
  });
  return {
    included: rows.filter((row) => row.item_state === 'included').map(member),
    withdrawn: rows.filter((row) => row.item_state === 'withdrawn').map(member),
  };
}

/** How many members (included and withdrawn) a current claim has. */
export async function claimMemberCount(
  tx: Tx,
  claim: MasterRecordClaim,
  source: ClaimMembersSource,
): Promise<number> {
  if (source.kind === 'manifest') return source.included.length + source.withdrawn.length;
  const row = await tx.one<{ count: string }>(
    `select /* master-record.member-count */ count(*)::text as count
       from content.master_record_item where master_record_id = $1`,
    [claim.id],
  );
  return Number(row.count);
}

/** How many of `ids` are members of a current claim, without reading their payloads. */
export async function claimMemberCountAmong(
  tx: Tx,
  claim: MasterRecordClaim,
  source: ClaimMembersSource,
  ids: readonly string[],
): Promise<number> {
  if (source.kind === 'manifest') {
    const wanted = new Set(ids);
    return [...source.included, ...source.withdrawn].filter((m) => wanted.has(m.objectId)).length;
  }
  const row = await tx.one<{ count: string }>(
    `select /* master-record.member-count-among */ count(*)::text as count
       from content.master_record_item
      where master_record_id = $1 and object_id = any($2::uuid[])`,
    [claim.id, [...ids]],
  );
  return Number(row.count);
}

/**
 * The claim's members among `ids`, exactly as its manifest lists them.
 *
 * Included members of a `kf-master-record-v3` claim are read from its item rows, which hold the
 * same object, type, classification, digest, title and payload (the statement check of
 * 20260926110000 and, before it, the per-row policy refuse an item that differs); a v3 member always
 * carries a title and a payload, so nothing the row cannot say is lost. Withdrawn members, and every
 * member of an older claim, are read from the manifest entries themselves, since their rows record
 * when the row was written rather than the withdrawal time the manifest states.
 */
export async function claimMembersAmong(
  tx: Tx,
  claim: MasterRecordClaim,
  source: ClaimMembersSource,
  ids: readonly string[],
): Promise<{
  readonly included: readonly PermissionMember[];
  readonly withdrawn: readonly PermissionMember[];
}> {
  if (ids.length === 0) return { included: [], withdrawn: [] };
  if (source.kind === 'manifest') {
    const wanted = new Set(ids);
    return {
      included: source.included.filter((member) => wanted.has(member.objectId)),
      withdrawn: source.withdrawn.filter((member) => wanted.has(member.objectId)),
    };
  }
  const rows = await tx.query<ItemRow & { content_payload: Record<string, unknown> }>(
    `select /* master-record.members-among */
            object_id, object_type, title, classification, content_digest, item_state,
            content_payload
       from content.master_record_item
      where master_record_id = $1 and object_id = any($2::uuid[])
      order by object_id`,
    [claim.id, [...ids]],
  );
  const fromManifest = async (
    state: 'included' | 'withdrawn',
    objectIds: readonly string[],
  ): Promise<PermissionMember[]> =>
    objectIds.length === 0
      ? []
      : (
          await tx.query<{ member: PermissionMember }>(
            `select /* master-record.manifest-members */ member
               from content.master_record master
              cross join lateral jsonb_array_elements(master.manifest -> $2::text) as member
              where master.id = $1 and member ->> 'objectId' = any($3::text[])
              order by member ->> 'objectId'`,
            [claim.id, state, [...objectIds]],
          )
        ).map((row) => row.member);
  const withdrawnIds = rows.filter((r) => r.item_state === 'withdrawn').map((r) => r.object_id);
  const includedRows = rows.filter((r) => r.item_state === 'included');
  const included =
    source.manifestFormat === 'kf-master-record-v3'
      ? includedRows.map((row): PermissionMember => ({
          objectId: row.object_id,
          objectType: row.object_type,
          organizationId: claim.organizationId,
          classification: row.classification,
          contentDigest: row.content_digest,
          title: row.title,
          content: row.content_payload,
        }))
      : await fromManifest(
          'included',
          includedRows.map((row) => row.object_id),
        );
  return { included, withdrawn: await fromManifest('withdrawn', withdrawnIds) };
}

/**
 * The active relation edges a structural walk of `maxDepth` hops from `anchorId` can cross: every
 * edge touching the anchor, then every edge touching what those reach, to `maxDepth` levels,
 * read under the caller's row security with the filters `enumerateRelevanceGraph` applies. This is
 * all of the graph `neighbourhoodScope` and `projectNeighbourhood` need; the policies are read
 * whole (they are a registry, not the graph).
 */
export async function enumerateNeighbourhoodGraph(
  tx: Tx,
  anchorId: string,
  maxDepth: number,
): Promise<{
  readonly edges: readonly RelevanceEdge[];
  readonly policies: readonly RelationPolicy[];
}> {
  const edges = new Map<string, RelevanceEdge>();
  const seen = new Set<string>([anchorId]);
  let frontier = [anchorId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const rows = await tx.query<{
      id: string;
      source_id: string;
      target_id: string;
      relation_type: string;
    }>(
      `select /* master-record.neighbourhood-edges */ id, source_id, target_id, relation_type
         from core.relation
        where (source_id = any($1::uuid[]) or target_id = any($1::uuid[]))
          and state = 'active'
          and valid_from <= now()
          and (valid_to is null or valid_to > now())
        order by id`,
      [frontier],
    );
    const next: string[] = [];
    for (const row of rows) {
      edges.set(row.id, {
        sourceId: row.source_id,
        targetId: row.target_id,
        relationType: row.relation_type,
      });
      for (const end of [row.source_id, row.target_id]) {
        if (!seen.has(end)) {
          seen.add(end);
          next.push(end);
        }
      }
    }
    frontier = next;
  }
  return { edges: [...edges.values()], policies: await enumerateRelationPolicies(tx) };
}
