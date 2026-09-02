import { canonicalize, digest } from '@kf/canonicalization';
import type {
  ProjectionDefinition,
  ProjectionFilter,
  ProjectionSection,
} from '@kf/ontology-compiler';
import { relevanceClosureWithMetrics } from './closure.js';
import type {
  ProjectionClassification,
  ProjectionInput,
  ProjectionMember,
  ProjectionParameterValue,
  ProjectionResult,
  ProjectionResultSection,
} from './types.js';

/** Thrown for a definition or input the engine refuses to evaluate; never for an empty result. */
export class ProjectionRefused extends Error {
  constructor(
    readonly reason:
      | 'unknown_parameter'
      | 'missing_parameter'
      | 'parameter_type'
      | 'budget_exceeded'
      | 'coverage'
      | 'foreign_member',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectionRefused';
  }
}

const RANK: Readonly<Record<ProjectionClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bind and validate parameters against the definition. Unknown and missing are both refusals. */
export function bindParameters(
  definition: ProjectionDefinition,
  supplied: Readonly<Record<string, ProjectionParameterValue>>,
): Readonly<Record<string, ProjectionParameterValue>> {
  const declared = new Map(definition.parameters.map((p) => [p.name, p]));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) {
      throw new ProjectionRefused(
        'unknown_parameter',
        `projection ${definition.id} declares no parameter '${name}'`,
      );
    }
  }
  const bound: Record<string, ProjectionParameterValue> = {};
  for (const param of definition.parameters) {
    const value = supplied[param.name];
    if (value === undefined) {
      if (param.required) {
        throw new ProjectionRefused(
          'missing_parameter',
          `projection ${definition.id} requires parameter '${param.name}'`,
        );
      }
      continue;
    }
    const bad = (why: string): never => {
      throw new ProjectionRefused(
        'parameter_type',
        `projection ${definition.id} parameter '${param.name}': ${why}`,
      );
    };
    switch (param.type) {
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          bad('expected a safe integer');
        }
        if (param.minimum !== undefined && (value as number) < param.minimum) {
          bad(`below minimum ${String(param.minimum)}`);
        }
        if (param.maximum !== undefined && (value as number) > param.maximum) {
          bad(`above maximum ${String(param.maximum)}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') bad('expected a boolean');
        break;
      case 'uuid':
        if (typeof value !== 'string' || !UUID.test(value)) bad('expected a uuid');
        break;
      case 'enum':
        if (typeof value !== 'string' || !(param.values ?? []).includes(value)) {
          bad(`expected one of ${(param.values ?? []).join(', ')}`);
        }
        break;
      case 'string':
        if (typeof value !== 'string') bad('expected a string');
        break;
    }
    bound[param.name] = value;
  }
  return bound;
}

function admits(filter: ProjectionFilter | undefined, member: ProjectionMember): boolean {
  if (filter === undefined) return true;
  if (filter.objectTypes !== undefined && !filter.objectTypes.includes(member.objectType)) {
    return false;
  }
  if (
    filter.lifecycleStates !== undefined &&
    (member.lifecycleState === undefined || !filter.lifecycleStates.includes(member.lifecycleState))
  ) {
    return false;
  }
  if (
    filter.classificationMax !== undefined &&
    RANK[member.classification] > RANK[filter.classificationMax as ProjectionClassification]
  ) {
    return false;
  }
  if (filter.itemStates !== undefined && !filter.itemStates.includes(member.itemState)) {
    return false;
  }
  return true;
}

function sortKey(member: ProjectionMember, fields: readonly string[]): string {
  const parts = fields.map((field) => {
    switch (field) {
      case 'object_id':
        return member.objectId;
      case 'object_type':
        return member.objectType;
      case 'title':
        return member.title ?? '';
      case 'classification':
        return member.classification;
      case 'lifecycle_state':
        return member.lifecycleState ?? '';
      default:
        return '';
    }
  });
  // The object id is always the final tiebreak, so two projections of one corpus order alike.
  return [...parts, member.objectId].join(' ');
}

function byKey(fields: readonly string[]) {
  return (left: ProjectionMember, right: ProjectionMember): number => {
    const a = sortKey(left, fields);
    const b = sortKey(right, fields);
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/**
 * Evaluate one projection over one corpus. Pure and deterministic: the same input yields the
 * same Result bytes, which is what makes `projectionDigest` mean something.
 *
 * Two invariants are enforced by construction and then asserted anyway:
 *   ⊆ master  — members only ever come from `corpus.members`; a section cannot introduce one.
 *   coverage  — every member lands in exactly one section, the remainder taking what nothing
 *               claimed. A member with no section is a thrown error, not a quiet omission.
 */
export function project(input: ProjectionInput): ProjectionResult {
  const { definition, corpus, graph } = input;
  const parameters = bindParameters(definition, input.parameters);

  for (const member of corpus.members) {
    if (member.organizationId !== corpus.organizationId) {
      throw new ProjectionRefused(
        'foreign_member',
        `member ${member.objectId} belongs to ${member.organizationId}, not ${corpus.organizationId}`,
      );
    }
  }
  if (corpus.members.length > definition.budgets.maxMembers) {
    throw new ProjectionRefused(
      'budget_exceeded',
      `projection ${definition.id} admits at most ${String(definition.budgets.maxMembers)} ` +
        `members; the corpus has ${String(corpus.members.length)}. Refusing rather than truncating.`,
    );
  }

  // Traversal. An explicit relation list is a whitelist of what may SEED relevance from the
  // person; once a record is reached, the ontology's propagation classes still govern descent.
  let reached: ReadonlySet<string> = new Set<string>();
  let fanoutByAnchorType: Readonly<Record<string, number>> = {};
  let fanoutByPropagationClass: Readonly<Record<string, number>> = {};
  const traverse = definition.traverse;
  if (traverse !== undefined) {
    const allowed =
      traverse.relations === 'person_anchors'
        ? new Set(graph.policies.filter((p) => p.personAnchor).map((p) => p.relationType))
        : new Set(traverse.relations);
    const policies = graph.policies.map((policy) =>
      allowed.has(policy.relationType)
        ? { ...policy, anchorDepth: Math.min(policy.anchorDepth, traverse.maxDepth) }
        : traverse.relations === 'person_anchors'
          ? policy
          : { ...policy, personAnchor: false },
    );
    const closure = relevanceClosureWithMetrics(corpus.personId, graph.edges, policies);
    reached = closure.ids;
    fanoutByAnchorType = closure.fanoutByAnchorType;
    fanoutByPropagationClass = closure.fanoutByPropagationClass;
  }

  // The definition-level filter is the ONE declared narrowing a projection may make. What it
  // excludes is not placed anywhere — that is what a narrowing means — but it is counted, so a
  // Result can never look complete while quietly omitting members.
  const candidates = corpus.members.filter((member) => admits(definition.filter, member));
  const excludedByFilter = corpus.members.length - candidates.length;
  const selects = (section: ProjectionSection, member: ProjectionMember): boolean => {
    switch (section.select) {
      case 'all':
        return true;
      case 'withdrawn':
        return member.itemState === 'withdrawn';
      case 'reached':
        return member.itemState === 'included' && reached.has(member.objectId);
      case 'unreached':
        return member.itemState === 'included' && !reached.has(member.objectId);
    }
  };

  const buckets = new Map<string, ProjectionMember[]>();
  for (const section of definition.sections) buckets.set(section.id, []);
  buckets.set(definition.remainder.id, []);
  for (const member of candidates) {
    const home = definition.sections.find((s) => selects(s, member) && admits(s.filter, member));
    buckets.get(home === undefined ? definition.remainder.id : home.id)!.push(member);
  }

  const order = byKey(definition.sort);
  const sections: ProjectionResultSection[] = [
    ...definition.sections.map((s) => ({
      id: s.id,
      title: s.title,
      members: [...buckets.get(s.id)!].sort(order),
    })),
    {
      id: definition.remainder.id,
      title: definition.remainder.title,
      members: [...buckets.get(definition.remainder.id)!].sort(order),
    },
  ];

  // Coverage, asserted after the fact even though the buckets make it structurally true:
  // a refactor of the loop above must not be able to drop a member silently.
  const placed = sections.reduce((n, s) => n + s.members.length, 0);
  if (placed !== candidates.length) {
    throw new ProjectionRefused(
      'coverage',
      `projection ${definition.id} placed ${String(placed)} of ${String(candidates.length)} members`,
    );
  }
  const known = new Set(corpus.members.map((m) => m.objectId));
  for (const section of sections) {
    for (const member of section.members) {
      if (!known.has(member.objectId)) {
        throw new ProjectionRefused(
          'foreign_member',
          `section ${section.id} holds ${member.objectId}, which is not in the corpus`,
        );
      }
    }
  }

  const sectionCounts = Object.fromEntries(sections.map((s) => [s.id, s.members.length]));
  const body = {
    format: 'kf-projection-result-v1' as const,
    definition: { id: definition.id, version: definition.version },
    parameters,
    source: {
      personId: corpus.personId,
      organizationId: corpus.organizationId,
      corpusDigest: corpus.corpusDigest,
    },
    sections,
    measurements: {
      memberCount: candidates.length,
      corpusMemberCount: corpus.members.length,
      excludedByFilter,
      sectionCounts,
      reachedCount: [...reached].filter((id) => known.has(id)).length,
      relevanceFanoutByAnchorType: fanoutByAnchorType,
      relevanceFanoutByPropagationClass: fanoutByPropagationClass,
    },
  };
  // The digest covers what the reader receives: definition + parameters + source identity +
  // exactly which members sit in which section, by id and content digest.
  const projectionDigest = digest({
    definition: body.definition,
    parameters: body.parameters,
    source: body.source,
    sections: sections.map((s) => ({
      id: s.id,
      members: s.members.map((m) => [m.objectId, m.contentDigest, m.itemState]),
    })),
  });
  const result: ProjectionResult = { ...body, projectionDigest };
  canonicalize(result);
  return result;
}
