import { canonicalize, taggedDigest } from '@kf/canonicalization';
import { isRecordVerification } from '@kf/domain';
import {
  PROJECTION_GRAMMAR_LIMITS,
  type ProjectionDefinition,
  type ProjectionFilter,
  type ProjectionSection,
} from '@kf/ontology-compiler';
import { relevanceClosureWithMetrics } from './closure.js';
import { neighbourhood } from './neighbourhood.js';
import type {
  ProjectionClassification,
  ProjectionCorpus,
  ProjectionInput,
  ProjectionMember,
  ProjectionParameterValue,
  ProjectionResult,
  ProjectionResultSection,
  RelevanceEdge,
} from './types.js';

/** Thrown for a definition or input the engine refuses to evaluate; never for an empty result. */
export class ProjectionRefused extends Error {
  constructor(
    readonly reason:
      | 'unknown_parameter'
      | 'missing_parameter'
      | 'parameter_type'
      | 'budget_exceeded'
      | 'unbounded_definition'
      | 'coverage'
      | 'foreign_member'
      | 'unlabelled_member',
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

function admits(
  filter: ProjectionFilter | undefined,
  member: ProjectionMember,
  reached: ReadonlySet<string>,
): boolean {
  if (filter === undefined) return true;
  if (filter.reachability !== undefined) {
    const isReached = reached.has(member.objectId);
    if (filter.reachability === 'reached' ? !isReached : isReached) return false;
  }
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

/** How `project` reads the clock. Injected by tests; the default is the monotonic clock. */
export interface ProjectOptions {
  readonly now?: () => number;
}

/**
 * Refuse a definition that is not statically bounded (KF-SAS-RQ-116).
 *
 * The compiler already refuses one, but the engine reads definitions from a compiled artifact
 * (or, later, from organization-authored records), and a bound checked only upstream is a bound
 * that holds only while every upstream path is the compiler.
 */
function assertBounded(definition: ProjectionDefinition): void {
  const { maxMembers, maxRuntimeMs } = definition.budgets as {
    readonly maxMembers?: unknown;
    readonly maxRuntimeMs?: unknown;
  };
  const within = (value: unknown, ceiling: number): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= ceiling;
  if (!within(maxMembers, PROJECTION_GRAMMAR_LIMITS.maxMembers)) {
    throw new ProjectionRefused(
      'unbounded_definition',
      `projection ${definition.id} declares no member budget within ` +
        `${String(PROJECTION_GRAMMAR_LIMITS.maxMembers)}`,
    );
  }
  if (!within(maxRuntimeMs, PROJECTION_GRAMMAR_LIMITS.maxRuntimeMs)) {
    throw new ProjectionRefused(
      'unbounded_definition',
      `projection ${definition.id} declares no runtime budget within ` +
        `${String(PROJECTION_GRAMMAR_LIMITS.maxRuntimeMs)} ms`,
    );
  }
  const depth = definition.traverse?.maxDepth;
  if (
    definition.traverse !== undefined &&
    !(
      typeof depth === 'number' &&
      Number.isInteger(depth) &&
      depth >= 0 &&
      depth <= PROJECTION_GRAMMAR_LIMITS.maxDepth
    )
  ) {
    throw new ProjectionRefused(
      'unbounded_definition',
      `projection ${definition.id} walks to depth ${String(depth)}; the grammar ceiling is ` +
        String(PROJECTION_GRAMMAR_LIMITS.maxDepth),
    );
  }
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
export function project(input: ProjectionInput, options: ProjectOptions = {}): ProjectionResult {
  return evaluate(input, options, undefined);
}

/**
 * A corpus handed to `projectNeighbourhood`: only the members an object reading can place — the
 * members among the anchor's neighbourhood — and how many members the whole corpus has.
 */
export interface NeighbourhoodCorpus extends ProjectionCorpus {
  /** Members of the whole corpus, included and withdrawn; `members` is the part in reach. */
  readonly corpusMemberCount: number;
}

/**
 * Whether a definition can be evaluated over its anchor's neighbourhood alone with the same Result
 * as over the whole corpus: an object reading whose declared filter admits only what the walk
 * reached. Every other member is then excluded by that filter — counted, never placed — so it
 * needs to be counted and nothing more.
 */
export function isNeighbourhoodReading(definition: ProjectionDefinition): boolean {
  return (
    definition.anchor === 'object' &&
    definition.traverse !== undefined &&
    definition.filter?.reachability === 'reached'
  );
}

function assertNeighbourhoodReading(definition: ProjectionDefinition): void {
  if (!isNeighbourhoodReading(definition)) {
    throw new ProjectionRefused(
      'coverage',
      `projection ${definition.id} places members outside its anchor's neighbourhood; ` +
        'it must be evaluated over the whole corpus',
    );
  }
}

/** The member budget, applied to however many members a reading evaluates. */
export function assertMemberBudget(definition: ProjectionDefinition, memberCount: number): void {
  assertBounded(definition);
  if (memberCount > definition.budgets.maxMembers) {
    throw new ProjectionRefused(
      'budget_exceeded',
      `projection ${definition.id} admits at most ${String(definition.budgets.maxMembers)} ` +
        `members; the corpus has ${String(memberCount)}. Refusing rather than truncating.`,
    );
  }
}

/**
 * The ids an object reading can place: the anchor and everything its structural walk reaches over
 * `graph`. A caller that loads exactly the corpus members among these, and passes them with the
 * corpus's size to `projectNeighbourhood`, gets the Result `project` gives over the whole corpus.
 * `graph` needs only the edges touching the nodes the walk expands (every node within
 * `traverse.maxDepth - 1` hops of the anchor); more edges change nothing.
 */
export function neighbourhoodScope(
  definition: ProjectionDefinition,
  parameters: Readonly<Record<string, ProjectionParameterValue>>,
  graph: ProjectionInput['graph'],
): ReadonlySet<string> {
  assertBounded(definition);
  assertNeighbourhoodReading(definition);
  const bound = bindParameters(definition, parameters);
  return walkFromObject(definition, String(bound['object_id']), graph.edges).ids;
}

/**
 * `project` over the anchor's neighbourhood only (see `neighbourhoodScope`). Refuses a definition
 * that could place a member outside it, and a member outside it — a caller that loaded more than
 * the scope has loaded something the reading is not about.
 */
export function projectNeighbourhood(
  input: ProjectionInput & { readonly corpus: NeighbourhoodCorpus },
  options: ProjectOptions = {},
): ProjectionResult {
  assertNeighbourhoodReading(input.definition);
  const { corpusMemberCount } = input.corpus;
  if (!Number.isSafeInteger(corpusMemberCount) || corpusMemberCount < input.corpus.members.length) {
    throw new ProjectionRefused(
      'coverage',
      `projection ${input.definition.id} was given ${String(input.corpus.members.length)} members ` +
        `of a corpus it was told has ${String(corpusMemberCount)}`,
    );
  }
  return evaluate(input, options, { corpusMemberCount });
}

function walkFromObject(
  definition: ProjectionDefinition,
  anchorId: string,
  edges: readonly RelevanceEdge[],
  tick?: () => void,
): { readonly ids: ReadonlySet<string>; readonly edges: readonly RelevanceEdge[] } {
  const traverse = definition.traverse!;
  const allowed =
    traverse.relations === 'all' || traverse.relations === 'person_anchors'
      ? undefined
      : new Set(traverse.relations);
  return neighbourhood(anchorId, edges, traverse.maxDepth, allowed, tick);
}

function evaluate(
  input: ProjectionInput,
  options: ProjectOptions,
  scope: { readonly corpusMemberCount: number } | undefined,
): ProjectionResult {
  const { definition, corpus, graph } = input;
  assertBounded(definition);
  // The runtime budget is a deadline, checked as the work is done rather than after it: a
  // walk that overruns is stopped and refused, never allowed to finish and then reported late.
  const now = options.now ?? (() => performance.now());
  const deadline = now() + definition.budgets.maxRuntimeMs;
  const tick = (): void => {
    if (now() > deadline) {
      throw new ProjectionRefused(
        'budget_exceeded',
        `projection ${definition.id} exceeded its runtime budget of ` +
          `${String(definition.budgets.maxRuntimeMs)} ms. Refusing rather than truncating.`,
      );
    }
  };
  const parameters = bindParameters(definition, input.parameters);

  for (const member of corpus.members) {
    if (member.organizationId !== corpus.organizationId) {
      throw new ProjectionRefused(
        'foreign_member',
        `member ${member.objectId} belongs to ${member.organizationId}, not ${corpus.organizationId}`,
      );
    }
    // KF-SAS-RQ-229: a projection that includes an unverified member labels it. Refused here,
    // before any section is built, so no surface downstream can receive a member it would have
    // to guess about — and a verified-looking label on an unverified record is refused as well.
    if (!isRecordVerification(member.verification)) {
      throw new ProjectionRefused(
        'unlabelled_member',
        `member ${member.objectId} carries no verification, or a label its facts do not produce`,
      );
    }
  }
  // Over a neighbourhood the budget bounds what the reading evaluates — the members in reach —
  // rather than a corpus it never loads.
  assertMemberBudget(definition, corpus.members.length);

  // The anchor. A person reading starts at the person; an object reading starts at the member
  // the reader named — and it must BE a member: anchoring outside the corpus would let a
  // projection reach things its reader was never authorized to see.
  const anchorId =
    definition.anchor === 'object' ? String(parameters['object_id']) : corpus.personId;
  if (
    definition.anchor === 'object' &&
    !corpus.members.some((member) => member.objectId === anchorId)
  ) {
    throw new ProjectionRefused(
      'foreign_member',
      `object ${anchorId} is not in this reader's corpus; a reading cannot be anchored outside it`,
    );
  }

  // Traversal. A person reading walks relevance: an explicit relation list is a whitelist of
  // what may SEED relevance, and propagation classes govern descent. An object reading walks
  // the structural neighbourhood: every named (or all) relation, both directions, to the depth
  // ceiling — that is what "what touches this record" means, and it is where backlinks come from.
  let reached: ReadonlySet<string> = new Set<string>();
  let fanoutByAnchorType: Readonly<Record<string, number>> = {};
  let fanoutByPropagationClass: Readonly<Record<string, number>> = {};
  let edges: readonly RelevanceEdge[] | undefined;
  const traverse = definition.traverse;
  if (traverse !== undefined && definition.anchor === 'object') {
    const walk = walkFromObject(definition, anchorId, graph.edges, tick);
    reached = walk.ids;
    edges = walk.edges;
    if (scope !== undefined) {
      const outside = corpus.members.find((member) => !reached.has(member.objectId));
      if (outside !== undefined) {
        throw new ProjectionRefused(
          'coverage',
          `member ${outside.objectId} is outside the neighbourhood of ${anchorId}, which is all ` +
            `a neighbourhood reading of ${definition.id} was given`,
        );
      }
    }
  } else if (traverse !== undefined) {
    const allowed =
      traverse.relations === 'person_anchors' || traverse.relations === 'all'
        ? new Set(graph.policies.filter((p) => p.personAnchor).map((p) => p.relationType))
        : new Set(traverse.relations);
    const policies = graph.policies.map((policy) =>
      allowed.has(policy.relationType)
        ? { ...policy, anchorDepth: Math.min(policy.anchorDepth, traverse.maxDepth) }
        : traverse.relations === 'person_anchors'
          ? policy
          : { ...policy, personAnchor: false },
    );
    const closure = relevanceClosureWithMetrics(corpus.personId, graph.edges, policies, tick);
    reached = closure.ids;
    fanoutByAnchorType = closure.fanoutByAnchorType;
    fanoutByPropagationClass = closure.fanoutByPropagationClass;
  }

  // The definition-level filter is the ONE declared narrowing a projection may make. What it
  // excludes is not placed anywhere — that is what a narrowing means — but it is counted, so a
  // Result can never look complete while quietly omitting members.
  const candidates = corpus.members.filter((member) => admits(definition.filter, member, reached));
  const corpusMemberCount = scope?.corpusMemberCount ?? corpus.members.length;
  const excludedByFilter = corpusMemberCount - candidates.length;
  const selects = (section: ProjectionSection, member: ProjectionMember): boolean => {
    switch (section.select) {
      case 'anchor':
        return member.objectId === anchorId;
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
    tick();
    const home = definition.sections.find(
      (s) => selects(s, member) && admits(s.filter, member, reached),
    );
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

  tick();
  const sectionCounts = Object.fromEntries(sections.map((s) => [s.id, s.members.length]));
  const placedIds = new Set(sections.flatMap((s) => s.members.map((m) => m.objectId)));
  const resultEdges =
    edges === undefined
      ? undefined
      : [...edges]
          .filter((e) => placedIds.has(e.sourceId) && placedIds.has(e.targetId))
          .sort((a, b) => {
            const ka = `${a.relationType} ${a.sourceId} ${a.targetId}`;
            const kb = `${b.relationType} ${b.sourceId} ${b.targetId}`;
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          });
  const body = {
    format: 'kf-projection-result-v2' as const,
    definition: { id: definition.id, version: definition.version },
    parameters,
    source: {
      personId: corpus.personId,
      organizationId: corpus.organizationId,
      corpusDigest: corpus.corpusDigest,
    },
    sections,
    ...(resultEdges === undefined ? {} : { edges: resultEdges }),
    measurements: {
      memberCount: candidates.length,
      corpusMemberCount,
      excludedByFilter,
      unverifiedCount: sections.reduce(
        (n, s) => n + s.members.filter((m) => !m.verification.verified).length,
        0,
      ),
      sectionCounts,
      reachedCount: [...reached].filter((id) => known.has(id)).length,
      relevanceFanoutByAnchorType: fanoutByAnchorType,
      relevanceFanoutByPropagationClass: fanoutByPropagationClass,
    },
  };
  const projectionDigest = projectionResultDigest(body);
  const result: ProjectionResult = { ...body, projectionDigest };
  canonicalize(result);
  return result;
}

/**
 * The digest a Result carries, recomputed from the Result itself.
 *
 * It covers what the reader receives: definition + parameters + source identity + exactly which
 * members sit in which section, by id and content digest — and, since v2, whether each was shown
 * as verified and on what basis. Two readings that differ only in which members were labelled
 * unverified told their readers different things. The format tag is in the preimage
 * (KF-SAS-RQ-158), so a v2 digest cannot collide with a v1 one. Measurements are not covered:
 * they describe the reading, they are not what was read.
 *
 * Exported so a consumer handed a Result — the agent context planner — can check that the
 * members it is about to use are the ones the digest names, rather than trusting the list.
 */
export function projectionResultDigest(
  result: Pick<ProjectionResult, 'format' | 'definition' | 'parameters' | 'source' | 'sections'> &
    Pick<Partial<ProjectionResult>, 'edges'>,
): string {
  return taggedDigest(result.format, {
    definition: result.definition,
    parameters: result.parameters,
    source: result.source,
    sections: result.sections.map((s) => ({
      id: s.id,
      members: s.members.map((m) => [
        m.objectId,
        m.contentDigest,
        m.itemState,
        m.verification.verified
          ? ['verified', m.verification.basis, m.verification.verifiedAt, m.verification.verifiedBy]
          : ['unverified', m.verification.label],
      ]),
    })),
    ...(result.edges === undefined
      ? {}
      : { edges: result.edges.map((e) => [e.relationType, e.sourceId, e.targetId]) }),
  });
}
