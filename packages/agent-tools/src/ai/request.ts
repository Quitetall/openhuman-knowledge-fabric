import type { AiContextItem, AiContextKind, AiProposalRequest } from './types.js';
import {
  atOrBelow,
  CONTEXT_KINDS,
  exactKeys,
  MAX_CONTEXT_CHARACTERS,
  MAX_CONTEXT_ITEMS,
  MAX_INSTRUCTION_CHARACTERS,
  record,
  requireClassification,
  requireNonempty,
  requirePositiveSafeInteger,
  requireSha256,
} from './primitives.js';

function validateContextItem(value: unknown, index: number): AiContextItem {
  const item = record(value, `context[${String(index)}]`);
  exactKeys(
    item,
    [
      'subjectId',
      'revisionId',
      'classification',
      'kind',
      'content',
      'tokenCount',
      'provenanceDigest',
    ],
    `context[${String(index)}]`,
  );
  if (typeof item['kind'] !== 'string' || !CONTEXT_KINDS.has(item['kind'] as AiContextKind)) {
    throw new Error(`context[${String(index)}].kind is not supported`);
  }
  return Object.freeze({
    subjectId: requireNonempty(item['subjectId'], 'context subjectId'),
    revisionId: requireNonempty(item['revisionId'], 'context revisionId'),
    classification: requireClassification(item['classification'], 'context classification'),
    kind: item['kind'] as AiContextKind,
    content: requireNonempty(item['content'], 'context content'),
    tokenCount: requirePositiveSafeInteger(item['tokenCount'], 'context tokenCount'),
    provenanceDigest: requireSha256(item['provenanceDigest'], 'context provenance digest'),
  });
}

export function validateRequest(value: unknown): AiProposalRequest {
  const request = record(value, 'AI proposal request');
  exactKeys(
    request,
    [
      'requestId',
      'basisId',
      'instruction',
      'classification',
      'tokenizer',
      'tokenBudget',
      'context',
      'omittedSubjectIds',
    ],
    'AI proposal request',
  );
  if (!Array.isArray(request['context']) || request['context'].length > MAX_CONTEXT_ITEMS) {
    throw new Error(`context exceeds ${String(MAX_CONTEXT_ITEMS)} items`);
  }
  if (!Array.isArray(request['omittedSubjectIds'])) {
    throw new Error('omittedSubjectIds must be an array');
  }
  const tokenBudget = requirePositiveSafeInteger(request['tokenBudget'], 'token budget');
  const classification = requireClassification(request['classification'], 'request classification');
  const context = request['context'].map(validateContextItem);
  const revisions = new Map<string, string>();
  let contextCharacters = 0;
  let contextTokens = 0;
  for (const item of context) {
    contextCharacters += item.content.length;
    contextTokens += item.tokenCount;
    if (!Number.isSafeInteger(contextTokens) || contextTokens > tokenBudget) {
      throw new Error('context token count exceeds token budget');
    }
    const previous = revisions.get(item.subjectId);
    if (previous !== undefined) {
      throw new Error(
        previous === item.revisionId
          ? `context repeats subject ${item.subjectId}`
          : `context contains multiple revisions for subject ${item.subjectId}`,
      );
    }
    revisions.set(item.subjectId, item.revisionId);
    if (!atOrBelow(item.classification, classification)) {
      throw new Error('context item exceeds declared request classification');
    }
  }
  if (contextCharacters > MAX_CONTEXT_CHARACTERS) {
    throw new Error(`context exceeds ${String(MAX_CONTEXT_CHARACTERS)} characters`);
  }
  const omitted = new Set<string>();
  const omittedSubjectIds = request['omittedSubjectIds'].map((subjectId) => {
    const normalized = requireNonempty(subjectId, 'omitted subjectId');
    if (revisions.has(normalized)) throw new Error('subject cannot be both included and omitted');
    if (omitted.has(normalized)) throw new Error(`omitted subjects repeat ${normalized}`);
    omitted.add(normalized);
    return normalized;
  });
  return Object.freeze({
    requestId: requireNonempty(request['requestId'], 'requestId'),
    basisId: requireNonempty(request['basisId'], 'basisId'),
    instruction: requireNonempty(request['instruction'], 'instruction', MAX_INSTRUCTION_CHARACTERS),
    classification,
    tokenizer: requireNonempty(request['tokenizer'], 'tokenizer'),
    tokenBudget,
    context: Object.freeze(context),
    omittedSubjectIds: Object.freeze(omittedSubjectIds),
  });
}
