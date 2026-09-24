import {
  atOrBelow,
  MAX_INSTRUCTION_CHARACTERS,
  record,
  requireClassification,
  requireNonempty,
  requirePositiveSafeInteger,
} from './primitives.js';
import { projectionResultDigest, type ProjectionResult } from '@kf/projections';
import type { AiContextPlannerInput } from './types.js';

/** The only projection an agent's context may be drawn from (ontology/projections.yaml). */
export const AGENT_CONTEXT_PROJECTION = 'agent_context';

const MAX_QUERY_CHARACTERS = 4_096;
const MAX_SEED_SUBJECT_IDS = 64;

export function validatePlannerInput(input: AiContextPlannerInput): AiContextPlannerInput {
  const value = record(input, 'planner input');
  const scope = record(value['scope'], 'planner scope');
  const seedSubjectIds = value['seedSubjectIds'];
  if (!Array.isArray(seedSubjectIds)) throw new Error('seedSubjectIds must be an array');
  if (seedSubjectIds.length > MAX_SEED_SUBJECT_IDS) {
    throw new Error(`seedSubjectIds exceeds ${String(MAX_SEED_SUBJECT_IDS)} items`);
  }
  const maxClassification = requireClassification(
    scope['maxClassification'],
    'scope maxClassification',
  );
  const classification = requireClassification(value['classification'], 'request classification');
  if (!atOrBelow(classification, maxClassification)) {
    throw new Error('request classification exceeds planner scope');
  }
  const seeds = seedSubjectIds.map((seed) => requireNonempty(seed, 'seed subjectId'));
  const uniqueSeeds = new Set(seeds);
  if (uniqueSeeds.size !== seeds.length) throw new Error('seedSubjectIds must not contain repeats');
  const organizationId = requireNonempty(scope['organizationId'], 'scope organizationId');
  const actorId = requireNonempty(scope['actorId'], 'scope actorId');
  const projection = validateAgentContextProjection(value['projection'], {
    organizationId,
    actorId,
  });
  return Object.freeze({
    scope: Object.freeze({
      organizationId,
      maxClassification,
      actorId,
      actingRoleId: requireNonempty(scope['actingRoleId'], 'scope actingRoleId'),
    }),
    requestId: requireNonempty(value['requestId'], 'requestId'),
    basisId: requireNonempty(value['basisId'], 'basisId'),
    instruction: requireNonempty(value['instruction'], 'instruction', MAX_INSTRUCTION_CHARACTERS),
    classification,
    tokenizer: requireNonempty(value['tokenizer'], 'tokenizer'),
    tokenBudget: requirePositiveSafeInteger(value['tokenBudget'], 'token budget'),
    query: requireNonempty(value['query'], 'planner query', MAX_QUERY_CHARACTERS),
    seedSubjectIds: Object.freeze(seeds),
    projection,
  });
}

/**
 * Refuse anything but the planning principal's own `agent_context` Result, intact. The digest
 * is recomputed from the sections rather than trusted: a member list edited after the reading
 * was made would otherwise pass as the reading.
 */
function validateAgentContextProjection(
  value: unknown,
  principal: { readonly organizationId: string; readonly actorId: string },
): ProjectionResult {
  const projection = record(value, 'agent context projection') as unknown as ProjectionResult;
  if (projection.format !== 'kf-projection-result-v2') {
    throw new Error('agent context projection must be a kf-projection-result-v2 Result');
  }
  if (projection.definition?.id !== AGENT_CONTEXT_PROJECTION) {
    throw new Error(
      `agent context must be the ${AGENT_CONTEXT_PROJECTION} projection, not ${String(
        projection.definition?.id,
      )}`,
    );
  }
  if (
    projection.source?.personId !== principal.actorId ||
    projection.source.organizationId !== principal.organizationId
  ) {
    throw new Error('agent context projection is not a reading of the planning principal');
  }
  if (!Array.isArray(projection.sections)) {
    throw new Error('agent context projection has no sections');
  }
  if (projectionResultDigest(projection) !== projection.projectionDigest) {
    throw new Error('agent context projection digest does not match its members');
  }
  return projection;
}

/** The included members of a Result, across every section (the remainder is a section too). */
export function projectionMemberIds(projection: ProjectionResult): ReadonlySet<string> {
  return new Set(
    projection.sections.flatMap((section) =>
      section.members
        .filter((member) => member.itemState === 'included')
        .map((member) => member.objectId),
    ),
  );
}
