import { ActionRejected } from '@kf/actions';
import { digest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { coveringGrants, enumerateAccessCoverage } from '@kf/authorization';
import type {
  MasterRecordCompilation,
  MasterRecordWithheldItem,
  MasterRecordClassification,
  PermissionMember,
  RelevanceEdge,
  RelationPolicy,
} from './master-record.js';
import {
  buildWithheldLedger,
  compileMasterRecord,
  relevanceClosureWithMetrics,
  sectionMasterRecord,
  type MasterRecordManifest,
  type MasterRecordSections,
} from './master-record.js';

interface ObjectRow extends Record<string, unknown> {
  readonly id: string;
  readonly object_type: string;
  readonly organization_id: string;
  readonly classification: MasterRecordClassification;
  readonly title: string;
  readonly lifecycle_state: string;
  readonly row_version: string;
  readonly content_payload: Record<string, unknown>;
}

interface RelationRow extends Record<string, unknown> {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation_type: string;
}

interface RelationPolicyRow extends Record<string, unknown> {
  readonly id: string;
  readonly person_anchor: boolean;
  readonly propagation_class: RelationPolicy['propagationClass'];
  readonly anchor_depth: number;
}

interface ExclusionRow extends Record<string, unknown> {
  readonly object_id: string;
  readonly reason_class: 'legal_hold' | 'exclusion' | 'third_party';
  readonly reason: string;
  readonly authorizer: string;
  readonly created_at: Date;
}

interface RetentionHoldRow extends Record<string, unknown> {
  readonly object_id: string;
  readonly reason: string;
  readonly placed_by: string;
  readonly placed_at: Date;
}

interface ErasureTombstoneRow extends Record<string, unknown> {
  readonly external_content_sha256: string;
  readonly erased_at: Date;
  readonly policy_decision_ref: string;
}

const CLASSIFICATIONS = new Set<MasterRecordClassification>([
  'public',
  'internal',
  'confidential',
  'restricted',
]);

function classification(value: string): MasterRecordClassification {
  if (!CLASSIFICATIONS.has(value as MasterRecordClassification)) {
    throw new Error(`unknown registry classification in permission enumeration: ${value}`);
  }
  return value as MasterRecordClassification;
}

function contentDigests(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) contentDigests(item, result);
    return result;
  }
  if (typeof value !== 'object' || value === null) return result;
  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === 'sha256' || key === 'external_content_sha256') &&
      typeof nested === 'string' &&
      /^[0-9a-f]{64}$/.test(nested)
    ) {
      result.add(nested);
    }
    contentDigests(nested, result);
  }
  return result;
}

/**
 * Enumerate exactly what current RLS admits. Caller must bind organization and ceiling first;
 * this function never widens context or substitutes an application-side filter.
 */
export async function enumeratePermissionSet(
  tx: Tx,
  organizationId: string,
): Promise<readonly PermissionMember[]> {
  const rows = await tx.query<ObjectRow>(
    `select /* master-record.permission-set */
            id, object_type, organization_id, classification, title, lifecycle_state,
            row_version::text, content.master_record_payload(id) as content_payload
       from core.object
      where organization_id = $1
      order by id`,
    [organizationId],
  );
  return rows.map((row) => ({
    objectId: row.id,
    objectType: row.object_type,
    organizationId: row.organization_id,
    classification: classification(row.classification),
    title: row.title,
    // Core object has no content bytes. Include every visible envelope field and row version so
    // an update changes the permission-set identity rather than serving an old completeness
    // claim as if it were current.
    content: row.content_payload,
    contentDigest: digest({
      id: row.id,
      objectType: row.object_type,
      organizationId: row.organization_id,
      classification: row.classification,
      title: row.title,
      lifecycleState: row.lifecycle_state,
      rowVersion: row.row_version,
      content: row.content_payload,
    }),
  }));
}

/** Apply subtractive person entitlement to the RLS enumeration for invariant re-checks. */
export async function enumeratePermittedSet(
  tx: Tx,
  personId: string,
  organizationId: string,
): Promise<readonly PermissionMember[]> {
  const visible = await enumeratePermissionSet(tx, organizationId);
  const coverage = await enumerateAccessCoverage(tx, personId, organizationId);
  const excluded = await tx.query<{ object_id: string } & Record<string, unknown>>(
    `select object_id from content.person_entitlement_exclusion
      where subject_id = $1 and organization_id = $2 and released_at is null
     union
     select hold.object_id
       from core.retention_hold hold
       join core.object object on object.id = hold.object_id
      where object.organization_id = $2 and hold.released_at is null`,
    [personId, organizationId],
  );
  const excludedIds = new Set(excluded.map((row) => row.object_id));
  return visible.filter(
    (member) =>
      !excludedIds.has(member.objectId) &&
      coveringGrants(coverage, member.objectId, member.classification).length > 0,
  );
}

/** Read visible graph edges and compiler-owned propagation policy under the same RLS context. */
export async function enumerateRelevanceGraph(tx: Tx): Promise<{
  readonly edges: readonly RelevanceEdge[];
  readonly policies: readonly RelationPolicy[];
}> {
  const edges = await tx.query<RelationRow>(
    `select /* master-record.relevance-edges */ source_id, target_id, relation_type
       from core.relation
      where state = 'active'
        and valid_from <= now()
        and (valid_to is null or valid_to > now())
      order by id`,
  );
  const policies = await tx.query<RelationPolicyRow>(
    `select /* master-record.relevance-policy */
            id, person_anchor, propagation_class, anchor_depth
       from registry.relation_type
      order by id`,
  );
  return {
    edges: edges.map((edge) => ({
      sourceId: edge.source_id,
      targetId: edge.target_id,
      relationType: edge.relation_type,
    })),
    policies: policies.map((policy) => ({
      relationType: policy.id,
      personAnchor: policy.person_anchor,
      propagationClass: policy.propagation_class,
      anchorDepth: policy.anchor_depth,
    })),
  };
}

/** Read one immutable claim; latest is selected by compilation time, never by mutable status. */
export async function latestMasterRecord(
  tx: Tx,
  personId: string,
  organizationId: string,
): Promise<Record<string, unknown> | undefined> {
  return tx.maybeOne(
    `select /* master-record.latest */
            id, person_id, organization_id, compilation_run_id, effective_classification,
            corpus_digest, permission_digest, record_digest, manifest, compiled_at, recorded_at,
            recorded_by, recorded_by_action
       from content.master_record
      where person_id = $1 and organization_id = $2
      order by compiled_at desc, recorded_at desc, id desc
      limit 1`,
    [personId, organizationId],
  );
}

export async function masterRecordItems(
  tx: Tx,
  masterRecordId: string,
): Promise<readonly Record<string, unknown>[]> {
  return tx.query(
    `select /* master-record.items */
            object_id, object_type, title, classification, content_digest, item_state,
            withdrawn_at, withdrawal_reason, content_payload
       from content.master_record_item
      where master_record_id = $1
      order by item_state, object_type, object_id`,
    [masterRecordId],
  );
}

export async function masterRecordWithholdings(
  tx: Tx,
  masterRecordId: string,
): Promise<readonly Record<string, unknown>[]> {
  return tx.query(
    `select /* master-record.withholdings */
            id, object_id, reason_class, reason, authorizer, withheld_at, item_count
       from content.master_record_withholding
      where master_record_id = $1
      order by reason_class, object_id nulls first, id`,
    [masterRecordId],
  );
}

/**
 * Section a stored claim against the relation graph as it is NOW. This is how a new
 * `performed_by` edge reaches a person's record without a recompilation: the claim did not
 * change, only the reading of it did (ADR 0013).
 */
export async function deriveMasterRecordSections(
  tx: Tx,
  manifest: Pick<MasterRecordManifest, 'personId' | 'included'>,
): Promise<MasterRecordSections> {
  const graph = await enumerateRelevanceGraph(tx);
  const relevance = relevanceClosureWithMetrics(manifest.personId, graph.edges, graph.policies);
  return sectionMasterRecord(manifest, relevance);
}

/**
 * Compile and append one immutable master-record claim — or, when the corpus is already
 * claimed, return that claim. Identity is the corpus (ADR 0013), so compiling twice against
 * an unchanged corpus yields one record and a second action that recorded a decision to look,
 * not a second row that would have collided. All reads happen inside the caller's
 * transaction after identity has bound RLS context; no caller-supplied object list is trusted.
 */
export async function compileAndRecordMasterRecord(
  tx: Tx,
  options: {
    readonly personId: string;
    readonly organizationId: string;
    readonly effectiveClassification: MasterRecordClassification;
    readonly recordedBy: string;
    readonly recordedByAction: string;
    readonly compilationRunId?: string;
    readonly compiledAt?: string;
  },
): Promise<
  MasterRecordCompilation & { readonly masterRecordId: string; readonly reused: boolean }
> {
  const person = await tx.maybeOne<{ id: string }>(
    `select person.id
       from org.person person
       join core.object envelope on envelope.id = person.id
      where person.id = $1
        and person.organization = $2
        and envelope.organization_id = $2`,
    [options.personId, options.organizationId],
  );
  if (person === undefined) {
    throw new Error('master record person is not a member of the requested organization');
  }
  // Visible under RLS, then reachable under a live grant (ADR 0016): an organization-scoped
  // role covers everything, an object-scoped grant covers that object. Nothing ungranted
  // enters the corpus, so nothing ungranted can be "withheld" — it was never permitted.
  const visibleUnderRls = await enumeratePermissionSet(tx, options.organizationId);
  const coverage = await enumerateAccessCoverage(tx, options.personId, options.organizationId);
  const allVisible = visibleUnderRls.filter(
    (member) => coveringGrants(coverage, member.objectId, member.classification).length > 0,
  );
  const graph = await enumerateRelevanceGraph(tx);
  const exclusions = await tx.query<ExclusionRow>(
    `select /* master-record.entitlement-exclusions */ object_id, reason_class, reason,
            authorizer, created_at
       from content.person_entitlement_exclusion
      where subject_id = $1 and organization_id = $2 and released_at is null
      order by created_at, id`,
    [options.personId, options.organizationId],
  );
  const retentionHolds = await tx.query<RetentionHoldRow>(
    `select /* master-record.retention-holds */ h.object_id, h.reason, h.placed_by, h.placed_at
       from core.retention_hold h
       join core.object o on o.id = h.object_id
      where o.organization_id = $1 and h.released_at is null
      order by h.placed_at, h.id`,
    [options.organizationId],
  );
  const previous = await latestMasterRecord(tx, options.personId, options.organizationId);

  const exclusionsByObject = new Map<string, ExclusionRow[]>();
  for (const row of exclusions) {
    exclusionsByObject.set(row.object_id, [...(exclusionsByObject.get(row.object_id) ?? []), row]);
  }
  const holdsByObject = new Map<string, RetentionHoldRow[]>();
  for (const row of retentionHolds) {
    holdsByObject.set(row.object_id, [...(holdsByObject.get(row.object_id) ?? []), row]);
  }

  const thirdPartyReasons: string[] = [];
  const withheldItems: MasterRecordWithheldItem[] = [];
  const permitted = allVisible.filter((member) => {
    const objectExclusions = exclusionsByObject.get(member.objectId) ?? [];
    const objectHolds = holdsByObject.get(member.objectId) ?? [];
    if (objectExclusions.length === 0 && objectHolds.length === 0) return true;
    for (const exclusion of objectExclusions) {
      if (exclusion.reason_class === 'third_party') {
        thirdPartyReasons.push(exclusion.reason);
      } else {
        withheldItems.push({
          objectId: member.objectId,
          reasonClass: exclusion.reason_class,
          reason: exclusion.reason,
          authorizer: exclusion.authorizer,
          withheldAt: exclusion.created_at.toISOString(),
        });
      }
    }
    for (const hold of objectHolds) {
      withheldItems.push({
        objectId: member.objectId,
        reasonClass: 'legal_hold',
        reason: hold.reason,
        authorizer: hold.placed_by,
        withheldAt: hold.placed_at.toISOString(),
      });
    }
    return false;
  });

  const relevance = relevanceClosureWithMetrics(options.personId, graph.edges, graph.policies);
  const compilationTimestamp = options.compiledAt ?? new Date().toISOString();
  const previousItems =
    previous === undefined ? [] : await masterRecordItems(tx, String(previous['id']));
  const previousContentDigests = [
    ...new Set(previousItems.flatMap((item) => [...contentDigests(item['content_payload'])])),
  ];
  const tombstones =
    previousContentDigests.length === 0
      ? []
      : await tx.query<ErasureTombstoneRow>(
          `select tombstone.external_content_sha256, tombstone.erased_at,
                  request.policy_decision_ref
             from secure_object.erasure_tombstone tombstone
             join secure_object.erasure_request request
               on request.id = tombstone.erasure_request_id
            where request.organization_id = $1
              and tombstone.external_content_sha256 = any($2::text[])
            order by tombstone.erased_at, tombstone.id`,
          [options.organizationId, previousContentDigests],
        );
  const tombstoneByDigest = new Map<string, ErasureTombstoneRow>();
  for (const tombstone of tombstones) {
    if (!tombstoneByDigest.has(tombstone.external_content_sha256)) {
      tombstoneByDigest.set(tombstone.external_content_sha256, tombstone);
    }
  }
  const tombstoneFor = (item: Record<string, unknown>): ErasureTombstoneRow | undefined =>
    [...contentDigests(item['content_payload'])]
      .map((sha256) => tombstoneByDigest.get(sha256))
      .find((candidate): candidate is ErasureTombstoneRow => candidate !== undefined);
  // Withholding is still a visible permission member whose content is intentionally
  // subtracted. Only an object absent from the RLS enumeration is withdrawn; otherwise one
  // exclusion would be reported twice as both withdrawn and withheld.
  const visibleIds = new Set(allVisible.map((member) => member.objectId));
  const withdrawn = previousItems
    .filter(
      (item) => item['item_state'] === 'included' && !visibleIds.has(String(item['object_id'])),
    )
    .map((item) => {
      const tombstone = tombstoneFor(item);
      return {
        objectId: String(item['object_id']),
        objectType: String(item['object_type']),
        organizationId: options.organizationId,
        classification: classification(String(item['classification'])),
        contentDigest: String(item['content_digest']),
        content:
          typeof item['content_payload'] === 'object' && item['content_payload'] !== null
            ? (item['content_payload'] as Record<string, unknown>)
            : {},
        withdrawnAt: (tombstone?.erased_at ?? new Date(compilationTimestamp)).toISOString(),
        withdrawalReason:
          tombstone === undefined
            ? 'permission set no longer admits this object'
            : `secure-object erasure (${tombstone.policy_decision_ref})`,
        ...(item['title'] === undefined ? {} : { title: String(item['title']) }),
      };
    });
  const compilation = compileMasterRecord({
    personId: options.personId,
    organizationId: options.organizationId,
    effectiveClassification: options.effectiveClassification,
    permitted,
    relevantIds: relevance.ids,
    withdrawn,
    withheld: buildWithheldLedger(withheldItems, thirdPartyReasons),
    relevanceFanoutByPropagationClass: relevance.fanoutByPropagationClass,
    relevanceFanoutByAnchorType: relevance.fanoutByAnchorType,
    compiledAt: compilationTimestamp,
  });

  // Same corpus, same claim. The lookup is by the identity the table enforces, so a repeat
  // compilation can never reach the unique constraint and surface as a 500 — it finds the row
  // the constraint exists to protect. Sections are still derived fresh below, because the
  // graph may have moved even though the corpus did not.
  const existing = await tx.maybeOne<{ id: string; effective_classification: string }>(
    `select id, effective_classification from content.master_record
      where person_id = $1 and organization_id = $2 and corpus_digest = $3`,
    [options.personId, options.organizationId, compilation.manifest.corpusDigest],
  );
  if (existing !== undefined) {
    // The ceiling is the one thing the corpus digest deliberately excludes: it is an access
    // fact, recorded in permission_digest, not identity. So an identical corpus CAN be reached
    // under two ceilings when every member sits at or below the lower one. Reusing the row
    // would then hand back a claim whose recorded access fact belongs to a different request.
    // That is refused loudly rather than papered over; it is an edge ADR 0013 names.
    if (existing.effective_classification !== options.effectiveClassification) {
      // A named refusal, not a bare Error: the route turns ActionRejected into a structured
      // 4xx. A plain throw here would surface as 500 internal_error — the exact shape ADR 0013
      // removed for the other collision.
      throw new ActionRejected(
        'precondition_failed',
        `master record for this corpus already exists under ceiling ` +
          `${existing.effective_classification}; compiling the same corpus under ` +
          `${options.effectiveClassification} would reuse a claim whose recorded access fact ` +
          'belongs to a different request (ADR 0013)',
      );
    }
    return { ...compilation, masterRecordId: existing.id, reused: true };
  }

  const master = await tx.one<{ id: string }>(
    `insert into content.master_record
       (person_id, organization_id, compilation_run_id, effective_classification,
        corpus_digest, permission_digest, record_digest, manifest, compiled_at, recorded_by,
        recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
     returning id`,
    [
      options.personId,
      options.organizationId,
      options.compilationRunId ?? null,
      options.effectiveClassification,
      compilation.manifest.corpusDigest,
      compilation.manifest.permissionDigest,
      digest(compilation.manifest),
      JSON.stringify(compilation.manifest),
      compilation.manifest.compiledAt,
      options.recordedBy,
      options.recordedByAction,
    ],
  );

  for (const member of compilation.manifest.included) {
    await tx.query(
      `insert into content.master_record_item
         (master_record_id, object_id, object_type, title, classification, content_digest,
          item_state, content_payload)
       values ($1,$2,$3,$4,$5,$6,'included',$7::jsonb)`,
      [
        master.id,
        member.objectId,
        member.objectType,
        member.title ?? member.objectType,
        member.classification,
        member.contentDigest,
        JSON.stringify(member.content ?? {}),
      ],
    );
  }
  for (const member of compilation.manifest.withdrawn) {
    await tx.query(
      `insert into content.master_record_item
         (master_record_id, object_id, object_type, title, classification, content_digest,
          item_state, withdrawn_at, withdrawal_reason, content_payload)
       values ($1,$2,$3,$4,$5,$6,'withdrawn',now(),$7,$8::jsonb)`,
      [
        master.id,
        member.objectId,
        member.objectType,
        member.title ?? member.objectType,
        member.classification,
        member.contentDigest,
        member.withdrawalReason ?? 'permission set no longer admits this object',
        JSON.stringify(member.content ?? {}),
      ],
    );
  }
  for (const item of compilation.manifest.withheld.items) {
    await tx.query(
      `insert into content.master_record_withholding
         (master_record_id, object_id, reason_class, reason, authorizer, withheld_at, item_count)
       values ($1,$2,$3,$4,$5,$6,1)`,
      [master.id, item.objectId, item.reasonClass, item.reason, item.authorizer, item.withheldAt],
    );
  }
  for (const [, count] of Object.entries(compilation.manifest.withheld.thirdPartyCounts)) {
    await tx.query(
      `insert into content.master_record_withholding
       (master_record_id, reason_class, reason, authorizer, withheld_at, item_count)
       values ($1,'third_party','third-party material withheld',$2,now(),$3)`,
      [master.id, options.recordedBy, count],
    );
  }
  return { ...compilation, masterRecordId: master.id, reused: false };
}
