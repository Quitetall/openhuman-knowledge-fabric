import {
  atOrBelow,
  MAX_INSTRUCTION_CHARACTERS,
  record,
  requireClassification,
  requireNonempty,
  requirePositiveSafeInteger,
} from './primitives.js';
import type { AiContextPlannerInput } from './types.js';

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
  return Object.freeze({
    scope: Object.freeze({
      organizationId: requireNonempty(scope['organizationId'], 'scope organizationId'),
      maxClassification,
      actorId: requireNonempty(scope['actorId'], 'scope actorId'),
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
  });
}
