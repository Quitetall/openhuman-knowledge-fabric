import { canonicalize, digest } from '@kf/canonicalization';

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

export interface MasterRecordManifest {
  readonly format: 'kf-master-record-v1';
  readonly personId: string;
  readonly organizationId: string;
  readonly compiledAt: string;
  readonly permissionDigest: string;
  readonly included: readonly PermissionMember[];
  readonly sections: Readonly<{
    readonly yourRecord: readonly string[];
    readonly organizationView: readonly string[];
  }>;
  /** Measured cardinalities used for storage/rendering budgets; never membership filters. */
  readonly measurements?: Readonly<{
    readonly permissionMemberCount: number;
    readonly relevantMemberCount: number;
    readonly organizationViewMemberCount: number;
    /** Relevance closure cardinality attributed to each person-anchoring relation type. */
    readonly relevanceFanoutByAnchorType: Readonly<Record<string, number>>;
    /** Aggregate closure cardinality by ontology propagation class. */
    readonly relevanceFanoutByPropagationClass: Readonly<Record<string, number>>;
  }>;
  readonly withdrawn: readonly PermissionMember[];
  readonly withheld: MasterRecordWithheldLedger;
}

export interface MasterRecordCompilation {
  readonly manifest: MasterRecordManifest;
  readonly relevant: readonly PermissionMember[];
  readonly organizationView: readonly PermissionMember[];
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

/** Canonical digest of the exact permitted set, independent of database row order. */
export function permissionDigest(members: readonly PermissionMember[]): string {
  return digest(sortedMembers(members));
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

/** Refuse serving a record whose permission set changed after compilation. */
export function assertPermissionDigest(
  manifest: Pick<MasterRecordManifest, 'permissionDigest'>,
  currentPermitted: readonly PermissionMember[],
): void {
  const actual = permissionDigest(currentPermitted);
  if (actual !== manifest.permissionDigest) {
    throw new Error(
      `master record is stale: manifest permission digest ${manifest.permissionDigest} ` +
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
  manifest: Pick<MasterRecordManifest, 'permissionDigest' | 'included'>,
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
  assertPermissionDigest(manifest, currentPermitted);
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

/** Traverse relevance once while recording fan-out by ontology propagation class. */
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
      const nextNode: QueueNode = {
        id: nextId,
        depth: nextDepth,
        authorityHops:
          current.authorityHops +
          (policy.propagationClass === 'authority_one_hop_up' && isIncoming ? 1 : 0),
        ...(nextAnchorType === undefined ? {} : { anchorType: nextAnchorType }),
      };
      const nextState = stateKey(nextNode);
      if (visitedStates.has(nextState)) continue;
      visitedStates.add(nextState);
      if (nextAnchorType !== undefined) {
        const reachedByAnchor = fanoutByAnchorType.get(nextAnchorType) ?? new Set<string>();
        reachedByAnchor.add(nextId);
        fanoutByAnchorType.set(nextAnchorType, reachedByAnchor);
      }
      if (!relevant.has(nextId)) {
        relevant.add(nextId);
        const reachedByClass =
          fanoutByPropagationClass.get(policy.propagationClass) ?? new Set<string>();
        reachedByClass.add(nextId);
        fanoutByPropagationClass.set(policy.propagationClass, reachedByClass);
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

/** Build one organization-scoped record; cross-organization members are rejected. */
export function compileMasterRecord(options: {
  readonly personId: string;
  readonly organizationId: string;
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
  const relevant = included.filter((member) => options.relevantIds.has(member.objectId));
  const organizationView = included.filter((member) => !options.relevantIds.has(member.objectId));
  const manifest: MasterRecordManifest = {
    format: 'kf-master-record-v1',
    personId: options.personId,
    organizationId: options.organizationId,
    compiledAt: options.compiledAt ?? new Date().toISOString(),
    permissionDigest: permissionDigest(included),
    included,
    sections: {
      yourRecord: relevant.map((member) => member.objectId),
      organizationView: organizationView.map((member) => member.objectId),
    },
    measurements: {
      permissionMemberCount: included.length,
      relevantMemberCount: relevant.length,
      organizationViewMemberCount: organizationView.length,
      relevanceFanoutByAnchorType: options.relevanceFanoutByAnchorType ?? {},
      relevanceFanoutByPropagationClass: options.relevanceFanoutByPropagationClass ?? {},
    },
    withdrawn: sortedMembers(options.withdrawn ?? []),
    withheld: options.withheld ?? { items: [], thirdPartyCounts: {} },
  };
  // Keep a cheap canonicalization assertion beside the constructor. It catches accidental
  // addition of non-serializable fields before the manifest becomes a persisted claim.
  canonicalize(manifest);
  return { manifest, relevant, organizationView };
}
