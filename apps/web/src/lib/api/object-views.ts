import { record } from './validation';

/**
 * The Object View as the API serves it: a projection Result (members and relationships from
 * one engine) plus facets that are not corpus members. Parsed, never trusted.
 */
export interface ObjectViewMember {
  readonly objectId: string;
  readonly objectType: string;
  readonly classification: string;
  readonly contentDigest: string;
  readonly itemState: string;
  readonly lifecycleState?: string;
  readonly title?: string;
  readonly content?: Record<string, unknown>;
}

export interface ObjectView {
  readonly projectionDigest: string;
  readonly corpusDigest: string;
  readonly subject: ObjectViewMember;
  readonly relationships: readonly ObjectViewMember[];
  readonly edges: readonly {
    readonly sourceId: string;
    readonly targetId: string;
    readonly relationType: string;
  }[];
  readonly history: readonly {
    readonly seq: string;
    readonly action_type: string;
    readonly actor_id: string;
    readonly recorded_at: string;
    readonly reason: string | null;
  }[];
  readonly availableActions: readonly {
    readonly actionType: string;
    readonly toStates: readonly string[];
  }[];
}

function member(value: unknown): ObjectViewMember | undefined {
  const m = record(value);
  if (m === undefined) return undefined;
  const { objectId, objectType, classification, contentDigest, itemState } = m;
  if (
    typeof objectId !== 'string' ||
    typeof objectType !== 'string' ||
    typeof classification !== 'string' ||
    typeof contentDigest !== 'string' ||
    typeof itemState !== 'string'
  ) {
    return undefined;
  }
  return {
    objectId,
    objectType,
    classification,
    contentDigest,
    itemState,
    ...(typeof m['lifecycleState'] === 'string' ? { lifecycleState: m['lifecycleState'] } : {}),
    ...(typeof m['title'] === 'string' ? { title: m['title'] } : {}),
    ...(record(m['content']) === undefined ? {} : { content: record(m['content'])! }),
  };
}

export function parseObjectView(value: unknown): ObjectView {
  const body = record(value);
  const result = record(body?.['result']);
  const facets = record(body?.['facets']);
  const sections = result?.['sections'];
  if (result === undefined || !Array.isArray(sections)) {
    throw new Error('object view response is not a projection result');
  }
  const bySection = new Map<string, unknown[]>();
  for (const section of sections) {
    const s = record(section);
    if (s !== undefined && typeof s['id'] === 'string' && Array.isArray(s['members'])) {
      bySection.set(s['id'], s['members']);
    }
  }
  const subject = member(bySection.get('subject')?.[0]);
  if (subject === undefined) throw new Error('object view has no subject');
  const relationships = (bySection.get('relationships') ?? [])
    .map(member)
    .filter((m): m is ObjectViewMember => m !== undefined);
  const edges = (Array.isArray(result['edges']) ? result['edges'] : [])
    .map(record)
    .filter((e): e is Record<string, unknown> => e !== undefined)
    .filter(
      (e) =>
        typeof e['sourceId'] === 'string' &&
        typeof e['targetId'] === 'string' &&
        typeof e['relationType'] === 'string',
    )
    .map((e) => ({
      sourceId: String(e['sourceId']),
      targetId: String(e['targetId']),
      relationType: String(e['relationType']),
    }));
  const source = record(result['source']);
  const historyBody = record(facets?.['history']);
  const events = (Array.isArray(historyBody?.['events']) ? historyBody['events'] : [])
    .map(record)
    .filter((e): e is Record<string, unknown> => e !== undefined)
    .map((e) => ({
      seq: String(e['seq']),
      action_type: String(e['action_type']),
      actor_id: String(e['actor_id']),
      recorded_at: String(e['recorded_at']),
      reason: typeof e['reason'] === 'string' ? e['reason'] : null,
    }));
  const actions = (Array.isArray(facets?.['availableActions']) ? facets['availableActions'] : [])
    .map(record)
    .filter((a): a is Record<string, unknown> => a !== undefined)
    .map((a) => ({
      actionType: String(a['actionType']),
      toStates: Array.isArray(a['toStates']) ? a['toStates'].map(String) : [],
    }));
  return {
    projectionDigest: String(result['projectionDigest'] ?? ''),
    corpusDigest: String(source?.['corpusDigest'] ?? ''),
    subject,
    relationships,
    edges,
    history: events,
    availableActions: actions,
  };
}
