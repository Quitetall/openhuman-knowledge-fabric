export interface DocumentPlannerProposalBody {
  readonly proposalId?: unknown;
  readonly basisId?: unknown;
  readonly basisDigest?: unknown;
  readonly targetObjectId?: unknown;
  readonly baseRevisionId?: unknown;
  readonly targetRowVersion?: unknown;
  readonly instruction?: unknown;
  readonly query?: unknown;
  readonly tokenizer?: unknown;
  readonly tokenBudget?: unknown;
  readonly seedSubjectIds?: unknown;
  readonly idempotencyKey?: unknown;
  readonly reason?: unknown;
}

export interface ParsedDocumentPlannerProposal {
  readonly proposalId: string;
  readonly basisId: string;
  readonly basisDigest: string;
  readonly targetObjectId: string;
  readonly baseRevisionId: string;
  readonly targetRowVersion: number;
  readonly instruction: string;
  readonly query: string;
  readonly tokenizer: string;
  readonly tokenBudget: number;
  readonly seedSubjectIds: readonly string[];
  readonly idempotencyKey: string;
  readonly reason: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_QUERY_CHARACTERS = 4_096;
const MAX_INSTRUCTION_CHARACTERS = 16_384;
const MAX_TOKEN_BUDGET = 32_768;
const MAX_SEED_SUBJECT_IDS = 64;

function exactKeys(body: Readonly<Record<string, unknown>>): void {
  const allowed = new Set([
    'proposalId',
    'basisId',
    'basisDigest',
    'targetObjectId',
    'baseRevisionId',
    'targetRowVersion',
    'instruction',
    'query',
    'tokenizer',
    'tokenBudget',
    'seedSubjectIds',
    'idempotencyKey',
    'reason',
  ]);
  const unexpected = Object.keys(body)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new TypeError(`planner proposal has unexpected fields: ${unexpected.join(', ')}`);
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('planner proposal body must be an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${String(maximum)} characters`,
    );
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = text(value, field, 36);
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function digest(value: unknown, field: string): string {
  const parsed = text(value, field, 64);
  if (!DIGEST.test(parsed)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  return parsed;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(
      `${field} must be a positive safe integer no greater than ${String(maximum)}`,
    );
  }
  return value as number;
}

export function parseDocumentPlannerProposal(value: unknown): ParsedDocumentPlannerProposal {
  const body = record(value);
  exactKeys(body);
  const rawSeeds = body['seedSubjectIds'];
  if (!Array.isArray(rawSeeds)) throw new TypeError('seedSubjectIds must be an array');
  if (rawSeeds.length > MAX_SEED_SUBJECT_IDS) {
    throw new TypeError(
      `seedSubjectIds must contain at most ${String(MAX_SEED_SUBJECT_IDS)} items`,
    );
  }
  const seedSubjectIds = rawSeeds.map((seed, index) =>
    uuid(seed, `seedSubjectIds[${String(index)}]`),
  );
  if (new Set(seedSubjectIds).size !== seedSubjectIds.length) {
    throw new TypeError('seedSubjectIds must not contain duplicates');
  }
  const targetRowVersion = positiveInteger(
    body['targetRowVersion'],
    'targetRowVersion',
    Number.MAX_SAFE_INTEGER,
  );
  const reason = body['reason'] === undefined ? undefined : text(body['reason'], 'reason', 2_000);
  const idempotencyKey = text(body['idempotencyKey'], 'idempotencyKey', 128);
  if (idempotencyKey.length < 8) {
    throw new TypeError('idempotencyKey must be at least 8 characters');
  }
  return Object.freeze({
    proposalId: uuid(body['proposalId'], 'proposalId'),
    basisId: uuid(body['basisId'], 'basisId'),
    basisDigest: digest(body['basisDigest'], 'basisDigest'),
    targetObjectId: uuid(body['targetObjectId'], 'targetObjectId'),
    baseRevisionId: uuid(body['baseRevisionId'], 'baseRevisionId'),
    targetRowVersion,
    instruction: text(body['instruction'], 'instruction', MAX_INSTRUCTION_CHARACTERS),
    query: text(body['query'], 'query', MAX_QUERY_CHARACTERS),
    tokenizer: text(body['tokenizer'], 'tokenizer', 128),
    tokenBudget: positiveInteger(body['tokenBudget'], 'tokenBudget', MAX_TOKEN_BUDGET),
    seedSubjectIds: Object.freeze(seedSubjectIds),
    idempotencyKey,
    reason,
  });
}
