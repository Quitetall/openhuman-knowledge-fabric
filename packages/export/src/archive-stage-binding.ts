import { isRecord } from './internal/format.js';

type Row = Readonly<Record<string, unknown>>;

/** Compare supplied declarations only; caller owns source reconstruction/authentication. */
export function bindArchiveStages(
  inventory: unknown,
  currentRevision: number,
  packets: readonly Row[],
) {
  const matches: Row[] = [];
  const unresolved: Row[] = [];
  let declarations: Record<string, unknown>[] | undefined;
  if (inventory !== undefined) {
    if (
      !isRecord(inventory) ||
      !Array.isArray(inventory['declarations']) ||
      !inventory['declarations'].every(isRecord) ||
      !Array.isArray(inventory['unresolved']) ||
      !inventory['unresolved'].every((x) => typeof x === 'string') ||
      typeof inventory['history_retained'] !== 'boolean' ||
      inventory['execution_coverage_established'] !== false
    )
      throw new Error('Invalid archive stage inventory');
    declarations = inventory['declarations'];
    for (const declaration of declarations) {
      const graph = declaration['graph'];
      if (
        typeof declaration['source'] !== 'string' ||
        typeof declaration['manifest_source'] !== 'string' ||
        typeof declaration['source_digest'] !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(declaration['source_digest']) ||
        !isRecord(graph) ||
        !Array.isArray(graph['stages']) ||
        !graph['stages'].every(isRecord) ||
        !Array.isArray(graph['milestones']) ||
        !graph['milestones'].every(isRecord)
      )
        throw new Error('Invalid archive stage declaration');
    }
  }
  for (const packet of packets) {
    const identity = {
      dispatchDigest: packet['dispatch_digest'],
      stageId: packet['stage_id'],
      milestoneId: packet['milestone_id'],
    };
    if (packet['contract_revision'] !== currentRevision) {
      unresolved.push({
        ...identity,
        reason: 'historical source graph not bound to contract revision',
      });
      continue;
    }
    if (declarations === undefined) {
      unresolved.push({ ...identity, reason: 'source stage inventory unavailable' });
      continue;
    }
    const candidates = declarations.filter((declaration) => {
      if (String(declaration['manifest_source']).startsWith('__ow_archive__/history/'))
        return false;
      const graph = declaration['graph'] as Record<string, unknown>;
      const stages = graph['stages'] as Record<string, unknown>[];
      const milestones = graph['milestones'] as Record<string, unknown>[];
      return (
        stages.some((stage) => stage['id'] === packet['stage_id']) &&
        milestones.some(
          (milestone) =>
            milestone['id'] === packet['milestone_id'] &&
            Array.isArray(milestone['stage_refs']) &&
            milestone['stage_refs'].includes(packet['stage_id']),
        )
      );
    });
    if (candidates.length > 1) throw new Error('Ambiguous source stage declaration');
    const declaration = candidates[0];
    if (declaration === undefined) {
      unresolved.push({
        ...identity,
        reason: 'no retained current stage and milestone membership match',
      });
    } else {
      matches.push({
        ...identity,
        source: declaration['source'],
        sourceDigest: declaration['source_digest'],
        manifestSource: declaration['manifest_source'],
      });
    }
  }
  return { matches, unresolved, executionCoverageEstablished: false };
}
