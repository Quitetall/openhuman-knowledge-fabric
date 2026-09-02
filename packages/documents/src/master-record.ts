import { canonicalize, digestBytes } from '@kf/canonicalization';

export type MasterRecordClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export type MasterRecordWithheldReason = 'legal_hold' | 'exclusion' | 'third_party';

export interface PermissionMember {
  readonly objectId: string;
  readonly objectType: string;
  readonly organizationId: string;
  readonly classification: MasterRecordClassification;
  readonly contentDigest: string;
  readonly title?: string;
  /** Canonical, RLS-visible typed-row payload. Empty when no typed extension exists. */
  readonly content?: Readonly<Record<string, unknown>>;
  /** Present only for members carried forward from a prior compilation after withdrawal. */
  readonly withdrawnAt?: string;
  /** Machine-recorded reason for withdrawal; never used to decide membership. */
  readonly withdrawalReason?: string;
}

export interface RelevanceEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relationType: string;
}

export type RelationPropagationClass =
  | 'composition_down'
  | 'version_both'
  | 'provenance_backward'
  | 'lateral_none'
  | 'authority_one_hop_up';

export interface RelationPolicy {
  readonly relationType: string;
  readonly personAnchor: boolean;
  readonly propagationClass: RelationPropagationClass;
  readonly anchorDepth: number;
}

export interface MasterRecordWithheldItem {
  readonly objectId: string;
  readonly reasonClass: Exclude<MasterRecordWithheldReason, 'third_party'>;
  readonly reason: string;
  readonly authorizer: string;
  readonly withheldAt: string;
}

export interface MasterRecordWithheldLedger {
  /** Legal holds and person exclusions are item-level and explain themselves. */
  readonly items: readonly MasterRecordWithheldItem[];
  /** Third-party material is deliberately reduced to a bare count by reason class. */
  readonly thirdPartyCounts: Readonly<Record<string, number>>;
}

export type MasterRecordFormat = 'kf-master-record-v1' | 'kf-master-record-v2';

/**
 * The claim. Its identity is `corpusDigest` — the exact authorized corpus — and nothing else
 * (ADR 0013). Sections are NOT here: which members are "yours" is decided by the relevance
 * closure over the current relation graph, at read time, and ADR 0011 already said sections
 * are presentation partitions rather than membership. A `sections` field appears only on v1
 * manifests written before this was true, and is never read as authoritative.
 */
export interface MasterRecordManifest {
  readonly format: MasterRecordFormat;
  readonly personId: string;
  readonly organizationId: string;
  readonly compiledAt: string;
  /** Identity: sorted (object, type, content digest, classification, state) over included ∪ withdrawn. */
  readonly corpusDigest: string;
  /** The access fact behind the corpus: object ids under the effective ceiling. Not identity. */
  readonly permissionDigest: string;
  readonly effectiveClassification: MasterRecordClassification;
  readonly included: readonly PermissionMember[];
  /** Cardinalities used for storage/rendering budgets; never membership filters. */
  readonly measurements?: Readonly<{
    readonly permissionMemberCount: number;
  }>;
  readonly withdrawn: readonly PermissionMember[];
  readonly withheld: MasterRecordWithheldLedger;
  /** v1 only. Present on rows written before ADR 0013; ignored. */
  readonly sections?: Readonly<{
    readonly yourRecord: readonly string[];
    readonly organizationView: readonly string[];
  }>;
}

/**
 * A sectioning of one manifest by the relevance closure. Derived, dated by whoever asked, and
 * never stored as part of the claim — the same manifest sections differently as the relation
 * graph changes, and that is the point.
 */
export interface MasterRecordSections {
  readonly relevant: readonly PermissionMember[];
  readonly organizationView: readonly PermissionMember[];
  readonly relevantMemberCount: number;
  readonly organizationViewMemberCount: number;
  /** Relevance closure cardinality attributed to each person-anchoring relation type. */
  readonly relevanceFanoutByAnchorType: Readonly<Record<string, number>>;
  /** Aggregate closure cardinality by ontology propagation class. */
  readonly relevanceFanoutByPropagationClass: Readonly<Record<string, number>>;
}

export interface MasterRecordCompilation {
  readonly manifest: MasterRecordManifest;
  readonly sections: MasterRecordSections;
}

export interface PermissionComparison {
  readonly overDisclosure: readonly PermissionMember[];
  readonly underDisclosure: readonly PermissionMember[];
  readonly equal: boolean;
}

const memberKey = (member: PermissionMember): string =>
  `${member.objectId}\u0000${member.objectType}\u0000${member.contentDigest}`;

function sortedMembers(members: readonly PermissionMember[]): readonly PermissionMember[] {
  return [...members].sort((left, right) =>
    memberKey(left).localeCompare(memberKey(right), 'en', { sensitivity: 'variant' }),
  );
}

function memberMap(members: readonly PermissionMember[]): Map<string, PermissionMember> {
  return new Map(sortedMembers(members).map((member) => [memberKey(member), member]));
}

/**
 * Line-canonical digests, reproducible by PostgreSQL. Fields are joined with the unit
 * separator (0x1F; text cannot carry NUL), lines with a newline, and sorted in code-unit
 * order — which is "C" collation for the ASCII ids, hex digests and type names these carry.
 * `content.master_record_corpus_digest` and `content.master_record_permission_digest` compute
 * the same values and the table CHECKs a stored identity against its manifest.
 */
const FIELD = '\u001f';

// SAFETY: code-unit comparison equals PostgreSQL "C" collation only for ASCII. Every field
// these digests carry — uuids, hex digests, registry ids, the two state words — is ASCII by
// schema. A non-ASCII object_type or classification id would have to get past
// registry.classification / core.object CHECKs first, and would then need this to become a
// byte-wise comparison on UTF-8 to keep agreeing with the database.
function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineDigest(lines: readonly string[]): string {
  return digestBytes(Buffer.from([...lines].sort(byteOrder).join('\n'), 'utf8'));
}

/** Identity of a claim: the exact authorized corpus, including what was withdrawn from it. */
export function corpusDigest(
  included: readonly PermissionMember[],
  // Required, not defaulted: withdrawal is identity (ADR 0013), and a caller that forgets the
  // withdrawn members would compute a different claim without noticing.
  withdrawn: readonly PermissionMember[],
): string {
  const line = (member: PermissionMember, state: 'included' | 'withdrawn'): string =>
    [member.objectId, member.objectType, member.contentDigest, member.classification, state].join(
      FIELD,
    );
  return lineDigest([
    ...included.map((member) => line(member, 'included')),
    ...withdrawn.map((member) => line(member, 'withdrawn')),
  ]);
}

/** The access fact: which objects, under which ceiling. Explains a corpus change; is not identity. */
export function permissionDigest(
  members: readonly PermissionMember[],
  effectiveClassification: MasterRecordClassification,
): string {
  return lineDigest([
    `ceiling${FIELD}${effectiveClassification}`,
    ...members.map((member) => `object${FIELD}${member.objectId}`),
  ]);
}

/** Compare both directions. Equality requires no over- or under-disclosure. */
export function comparePermissionSet(
  permitted: readonly PermissionMember[],
  compiled: readonly PermissionMember[],
): PermissionComparison {
  const permittedMap = memberMap(permitted);
  const compiledMap = memberMap(compiled);
  const overDisclosure = [...compiledMap.entries()]
    .filter(([key]) => !permittedMap.has(key))
    .map(([, member]) => member);
  const underDisclosure = [...permittedMap.entries()]
    .filter(([key]) => !compiledMap.has(key))
    .map(([, member]) => member);
  return {
    overDisclosure,
    underDisclosure,
    equal: overDisclosure.length === 0 && underDisclosure.length === 0,
  };
}

/** Refuse serving a record whose corpus changed after compilation. */
export function assertCorpusDigest(
  manifest: Pick<MasterRecordManifest, 'corpusDigest' | 'withdrawn'>,
  currentPermitted: readonly PermissionMember[],
): void {
  const actual = corpusDigest(currentPermitted, manifest.withdrawn);
  if (actual !== manifest.corpusDigest) {
    throw new Error(
      `master record is stale: manifest corpus digest ${manifest.corpusDigest} ` +
        `does not match current ${actual}`,
    );
  }
}

/**
 * Enforce both directions of the master-record invariant against a fresh enumeration.
 * Over-disclosure and under-disclosure are reported separately because they have different
 * operational consequences and must not collapse into a generic digest mismatch.
 */
export function assertPermissionSetInvariant(
  manifest: Pick<MasterRecordManifest, 'corpusDigest' | 'included' | 'withdrawn'>,
  currentPermitted: readonly PermissionMember[],
): PermissionComparison {
  const comparison = comparePermissionSet(currentPermitted, manifest.included);
  if (comparison.overDisclosure.length > 0) {
    throw new Error(
      `master record over-disclosure: ${comparison.overDisclosure
        .map((member) => member.objectId)
        .join(',')}`,
    );
  }
  if (comparison.underDisclosure.length > 0) {
    throw new Error(
      `master record under-disclosure: ${comparison.underDisclosure
        .map((member) => member.objectId)
        .join(',')}`,
    );
  }
  assertCorpusDigest(manifest, currentPermitted);
  return comparison;
}

/**
 * Compute relevance from relation metadata. The visited set is the termination guard: relation
 * declarations may say a type is acyclic, but provenance data is still allowed to contain a
 * cycle and the traversal must remain total.
 */
export function relevanceClosure(
  personId: string,
  edges: readonly RelevanceEdge[],
  policies: readonly RelationPolicy[],
): ReadonlySet<string> {
  return relevanceClosureWithMetrics(personId, edges, policies).ids;
}

/** Traverse relevance once while recording fan-out by person anchor and ontology class. */
export function relevanceClosureWithMetrics(
  personId: string,
  edges: readonly RelevanceEdge[],
  policies: readonly RelationPolicy[],
): {
  readonly ids: ReadonlySet<string>;
  readonly fanoutByAnchorType: Readonly<Record<string, number>>;
  readonly fanoutByPropagationClass: Readonly<Record<string, number>>;
} {
  const policyByType = new Map(policies.map((policy) => [policy.relationType, policy]));
  const outgoing = new Map<string, RelevanceEdge[]>();
  const incoming = new Map<string, RelevanceEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge]);
    incoming.set(edge.targetId, [...(incoming.get(edge.targetId) ?? []), edge]);
  }

  const relevant = new Set<string>([personId]);
  const fanoutByAnchorType = new Map<string, Set<string>>();
  const fanoutByPropagationClass = new Map<string, Set<string>>();
  type QueueNode = { id: string; depth: number; authorityHops: number; anchorType?: string };
  const queue: QueueNode[] = [{ id: personId, depth: 0, authorityHops: 0 }];
  // Global membership keeps the returned closure compact. Per-anchor state keeps measurements
  // honest when two person anchors reach the same object: each anchor gets its own closure count,
  // while cycles still terminate even when the ontology deliberately permits them.
  const stateKey = (node: QueueNode): string =>
    `${node.anchorType ?? ''}\u0000${node.id}\u0000${String(node.authorityHops)}`;
  const visitedStates = new Set<string>([stateKey(queue[0]!)]);
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++]!;
    const candidates = [...(outgoing.get(current.id) ?? []), ...(incoming.get(current.id) ?? [])];
    for (const edge of candidates) {
      const policy = policyByType.get(edge.relationType);
      if (policy === undefined) {
        throw new Error(`missing relevance policy for relation type '${edge.relationType}'`);
      }
      if (policy.propagationClass === 'lateral_none') continue;
      const anchorHop = current.id === personId && current.anchorType === undefined;
      // `personAnchor` governs only the first hop. Once a record is reached, the ontology's
      // propagation class decides whether its descendants, versions, provenance, or authority
      // links are relevant; composition types such as `contains` are intentionally not anchors
      // because a person is not normally their source node.
      if (anchorHop && !policy.personAnchor) continue;
      const isIncoming = edge.targetId === current.id;
      const follows =
        policy.propagationClass === 'version_both' ||
        (policy.propagationClass === 'composition_down' && !isIncoming) ||
        // Provenance edges are source (derived record) -> target (source record). The first
        // person anchor may be either orientation; subsequent closure walks backward to the
        // source, which is the outgoing direction from the derived record.
        (policy.propagationClass === 'provenance_backward' && (anchorHop || !isIncoming)) ||
        (policy.propagationClass === 'authority_one_hop_up' &&
          isIncoming &&
          current.authorityHops === 0);
      if (!follows) continue;
      const nextId = isIncoming ? edge.sourceId : edge.targetId;
      const nextDepth = current.depth + 1;
      // Composition and provenance are full fixpoints. `anchorDepth` bounds only the initial
      // stance toward a person; no rendering/storage budget is allowed to turn into membership
      // loss. Authority remains one hop by its propagation class.
      if (anchorHop && nextDepth > policy.anchorDepth) continue;
      const nextAnchorType = anchorHop ? policy.relationType : current.anchorType;
      // A cycle may return to the subject through an already-anchored path. Treat that node as a
      // terminal cycle edge; restarting the subject's outgoing relations would bypass their
      // personAnchor declarations and turn an unrelated edge into relevance.
      if (nextId === personId && current.anchorType !== undefined) continue;
      const nextNode: QueueNode = {
        id: nextId,
        depth: nextDepth,
        authorityHops:
          current.authorityHops +
          (policy.propagationClass === 'authority_one_hop_up' && isIncoming ? 1 : 0),
        ...(nextAnchorType === undefined ? {} : { anchorType: nextAnchorType }),
      };
      // Metrics describe every reachable edge path, not only states that still need traversal.
      // Record them before state deduplication so one anchor reaching a node through two classes
      // appears in both class fan-outs while the queue remains finite.
      if (nextAnchorType !== undefined) {
        const reachedByAnchor = fanoutByAnchorType.get(nextAnchorType) ?? new Set<string>();
        reachedByAnchor.add(nextId);
        fanoutByAnchorType.set(nextAnchorType, reachedByAnchor);
      }
      // Class measurements are independent of global membership. A shared node reached through
      // composition and provenance belongs in both class fan-outs even though the returned
      // closure stores it once.
      const reachedByClass =
        fanoutByPropagationClass.get(policy.propagationClass) ?? new Set<string>();
      reachedByClass.add(nextId);
      fanoutByPropagationClass.set(policy.propagationClass, reachedByClass);
      const nextState = stateKey(nextNode);
      if (visitedStates.has(nextState)) continue;
      visitedStates.add(nextState);
      if (!relevant.has(nextId)) {
        relevant.add(nextId);
      }
      queue.push(nextNode);
    }
  }
  return {
    ids: relevant,
    fanoutByAnchorType: Object.fromEntries(
      [...fanoutByAnchorType.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en', { sensitivity: 'variant' }))
        .map(([anchorType, ids]) => [anchorType, ids.size]),
    ),
    fanoutByPropagationClass: Object.fromEntries(
      [...fanoutByPropagationClass.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en', { sensitivity: 'variant' }))
        .map(([propagationClass, ids]) => [propagationClass, ids.size]),
    ),
  };
}

/** Apply explicit withholding policy without leaking third-party object identity. */
export function buildWithheldLedger(
  items: readonly MasterRecordWithheldItem[],
  thirdPartyReasons: readonly string[],
): MasterRecordWithheldLedger {
  const sortedItems = [...items].sort((left, right) => left.objectId.localeCompare(right.objectId));
  const thirdPartyCounts: Record<string, number> = {};
  for (const _reason of thirdPartyReasons) {
    // The reason text can identify a supplier or protected relationship. Person-facing
    // manifests expose only the mandated class/count, never that free-text explanation.
    thirdPartyCounts['third_party'] = (thirdPartyCounts['third_party'] ?? 0) + 1;
  }
  return { items: sortedItems, thirdPartyCounts };
}

/**
 * Section one manifest by a relevance closure. Pure: the closure is whatever the caller
 * enumerated, so the same claim can be sectioned again tomorrow against tomorrow's graph.
 */
export function sectionMasterRecord(
  manifest: Pick<MasterRecordManifest, 'included'>,
  relevance: {
    readonly ids: ReadonlySet<string>;
    readonly fanoutByAnchorType?: Readonly<Record<string, number>>;
    readonly fanoutByPropagationClass?: Readonly<Record<string, number>>;
  },
): MasterRecordSections {
  const included = sortedMembers(manifest.included);
  const relevant = included.filter((member) => relevance.ids.has(member.objectId));
  const organizationView = included.filter((member) => !relevance.ids.has(member.objectId));
  return {
    relevant,
    organizationView,
    relevantMemberCount: relevant.length,
    organizationViewMemberCount: organizationView.length,
    relevanceFanoutByAnchorType: relevance.fanoutByAnchorType ?? {},
    relevanceFanoutByPropagationClass: relevance.fanoutByPropagationClass ?? {},
  };
}

/** Build one organization-scoped record; cross-organization members are rejected. */
export function compileMasterRecord(options: {
  readonly personId: string;
  readonly organizationId: string;
  readonly effectiveClassification: MasterRecordClassification;
  readonly permitted: readonly PermissionMember[];
  readonly relevantIds: ReadonlySet<string>;
  readonly withdrawn?: readonly PermissionMember[];
  readonly withheld?: MasterRecordWithheldLedger;
  readonly relevanceFanoutByAnchorType?: Readonly<Record<string, number>>;
  readonly relevanceFanoutByPropagationClass?: Readonly<Record<string, number>>;
  readonly compiledAt?: string;
}): MasterRecordCompilation {
  const foreign = options.permitted.find(
    (member) => member.organizationId !== options.organizationId,
  );
  if (foreign !== undefined) {
    throw new Error(
      `master record cannot stitch organizations: ${foreign.objectId} belongs to ` +
        `${foreign.organizationId}, expected ${options.organizationId}`,
    );
  }
  const included = sortedMembers(options.permitted);
  const withdrawn = sortedMembers(options.withdrawn ?? []);
  const manifest: MasterRecordManifest = {
    format: 'kf-master-record-v2',
    personId: options.personId,
    organizationId: options.organizationId,
    compiledAt: options.compiledAt ?? new Date().toISOString(),
    corpusDigest: corpusDigest(included, withdrawn),
    permissionDigest: permissionDigest(included, options.effectiveClassification),
    effectiveClassification: options.effectiveClassification,
    included,
    measurements: { permissionMemberCount: included.length },
    withdrawn,
    withheld: options.withheld ?? { items: [], thirdPartyCounts: {} },
  };
  // Keep a cheap canonicalization assertion beside the constructor. It catches accidental
  // addition of non-serializable fields before the manifest becomes a persisted claim.
  canonicalize(manifest);
  return {
    manifest,
    sections: sectionMasterRecord(manifest, {
      ids: options.relevantIds,
      ...(options.relevanceFanoutByAnchorType === undefined
        ? {}
        : { fanoutByAnchorType: options.relevanceFanoutByAnchorType }),
      ...(options.relevanceFanoutByPropagationClass === undefined
        ? {}
        : { fanoutByPropagationClass: options.relevanceFanoutByPropagationClass }),
    }),
  };
}
