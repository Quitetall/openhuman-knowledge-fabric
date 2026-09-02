import type { RelevanceEdge } from './types.js';

/**
 * Structural neighbourhood: every active edge touching the anchor, both directions, to a depth
 * ceiling. No propagation policy — that is a relevance concept — because an object reading
 * asks "what is connected to this record", and a backlink is exactly as much of an answer as
 * a forward link. Deterministic: ids and edges come back in a stable order.
 */
export function neighbourhood(
  anchorId: string,
  edges: readonly RelevanceEdge[],
  maxDepth: number,
  allowedRelations?: ReadonlySet<string>,
): { readonly ids: ReadonlySet<string>; readonly edges: readonly RelevanceEdge[] } {
  const touching = new Map<string, RelevanceEdge[]>();
  for (const edge of edges) {
    if (allowedRelations !== undefined && !allowedRelations.has(edge.relationType)) continue;
    touching.set(edge.sourceId, [...(touching.get(edge.sourceId) ?? []), edge]);
    touching.set(edge.targetId, [...(touching.get(edge.targetId) ?? []), edge]);
  }
  const ids = new Set<string>([anchorId]);
  const crossed = new Map<string, RelevanceEdge>();
  let frontier = [anchorId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of touching.get(id) ?? []) {
        crossed.set(`${edge.relationType}\u0000${edge.sourceId}\u0000${edge.targetId}`, edge);
        const other = edge.sourceId === id ? edge.targetId : edge.sourceId;
        if (!ids.has(other)) {
          ids.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return { ids, edges: [...crossed.values()] };
}
