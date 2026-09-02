import type { RelevanceEdge, RelationPolicy } from './types.js';

/**
 * Relevance traversal. Owned here because a projection is the thing that walks the graph;
 * the master record's own sectioning is just the first projection (ADR 0013). `@kf/documents`
 * re-exports these for its callers.
 */

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
