import { compareCanonicalText } from '@kf/canonicalization';
import type {
  AiContextCandidate,
  AiContextChannel,
  AiContextPlan,
  AiContextPlannerScope,
  AiContextPlannerInput,
  AiContextPlannerRepository,
  AiOmittedContextRecord,
  AiProposalRequest,
} from './types.js';
import { atOrBelow, requireClassification, requireNonempty, requireSha256 } from './primitives.js';
import { validateRequest } from './request.js';
import { validatePlannerInput } from './planner-input.js';
import { markPlannedRequest } from './planned-request.js';

interface RankedCandidate extends AiContextCandidate {
  readonly channels: readonly AiContextChannel[];
  readonly score: number;
}

export async function planAiProposalContext(
  repository: AiContextPlannerRepository,
  input: AiContextPlannerInput,
): Promise<AiContextPlan> {
  const valid = validatePlannerInput(input);
  const [lexical, typed, vector] = await Promise.all([
    repository.authorizedLexicalCandidates(valid.scope, valid.query),
    repository.authorizedTypedRelationCandidates(valid.scope, valid.seedSubjectIds),
    repository.authorizedDerivedVectorCandidates?.(valid.scope, valid.query) ?? Promise.resolve([]),
  ]);
  const omitted: AiOmittedContextRecord[] = [];
  const candidates = [
    ...tagCandidates(lexical, 'lexical', valid, omitted),
    ...tagCandidates(typed, 'typed_relation', valid, omitted),
    ...tagCandidates(vector, 'derived_vector', valid, omitted),
  ];
  const ranked = [...dedupeCandidates(candidates, omitted)]
    .sort(compareRanked)
    .filter((candidate, index, all) => {
      const duplicate = all.findIndex((prior) => prior.subjectId === candidate.subjectId) !== index;
      if (duplicate) omit(omitted, candidate, 'duplicate_subject', 'lower ranked subject revision');
      return !duplicate;
    });
  const finalSelected = await selectAuthorizedWithinBudget(
    repository,
    valid.scope,
    ranked,
    valid.tokenBudget,
    omitted,
  );
  const selectedSubjects = new Set(finalSelected.map((candidate) => candidate.subjectId));
  const request = validateRequest({
    requestId: valid.requestId,
    basisId: valid.basisId,
    instruction: valid.instruction,
    classification: valid.classification,
    tokenizer: valid.tokenizer,
    tokenBudget: valid.tokenBudget,
    context: finalSelected.map(toContextItem),
    omittedSubjectIds: [...new Set(omitted.map((entry) => entry.subjectId))]
      .filter((subjectId) => !selectedSubjects.has(subjectId))
      .sort(compareCanonicalText),
  });
  return Object.freeze({
    request: markPlannedRequest(request),
    selected: Object.freeze(finalSelected),
    omitted: Object.freeze(omitted.sort(compareOmissions)),
  });
}

function tagCandidates(
  values: readonly AiContextCandidate[],
  channel: AiContextChannel,
  input: AiContextPlannerInput,
  omitted: AiOmittedContextRecord[],
): readonly RankedCandidate[] {
  return values.flatMap((candidate) => {
    try {
      requireNonempty(candidate.subjectId, 'candidate subjectId');
      requireNonempty(candidate.revisionId, 'candidate revisionId');
      requireNonempty(candidate.content, 'candidate content');
      requireSha256(candidate.provenanceDigest, 'candidate provenanceDigest');
      requireSha256(candidate.sourceDigest, 'candidate sourceDigest');
      const classification = requireClassification(
        candidate.classification,
        'candidate classification',
      );
      if (!atOrBelow(classification, input.classification)) {
        omit(
          omitted,
          candidate,
          'classification_ceiling',
          'candidate exceeds request classification',
        );
        return [];
      }
      if (!atOrBelow(candidate.classification, input.scope.maxClassification)) {
        omit(omitted, candidate, 'classification_ceiling', 'candidate exceeds caller scope');
        return [];
      }
      if (!Number.isSafeInteger(candidate.tokenCount) || candidate.tokenCount < 1) {
        throw new Error('candidate tokenCount must be positive');
      }
      const updatedAt = Date.parse(candidate.updatedAt);
      if (!Number.isFinite(updatedAt)) throw new Error('candidate updatedAt must be an instant');
      return [
        Object.freeze({
          ...candidate,
          channels: Object.freeze([channel]),
          score: score(candidate, channel),
        }),
      ];
    } catch (error: unknown) {
      omit(
        omitted,
        candidate,
        'invalid_candidate',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  });
}

function dedupeCandidates(
  candidates: readonly RankedCandidate[],
  omitted: AiOmittedContextRecord[],
): readonly RankedCandidate[] {
  const byRevision = new Map<string, RankedCandidate>();
  for (const candidate of candidates) {
    const prior = byRevision.get(candidateKey(candidate));
    if (prior === undefined) {
      byRevision.set(candidateKey(candidate), candidate);
      continue;
    }
    byRevision.set(
      candidateKey(candidate),
      Object.freeze({
        ...candidate,
        channels: Object.freeze([...new Set([...prior.channels, ...candidate.channels])]),
        score: Math.max(prior.score, candidate.score),
        verified: prior.verified || candidate.verified,
      }),
    );
    omit(omitted, candidate, 'duplicate_subject', 'duplicate candidate revision');
  }
  return [...byRevision.values()];
}

async function selectAuthorizedWithinBudget(
  repository: AiContextPlannerRepository,
  scope: AiContextPlannerScope,
  ranked: readonly RankedCandidate[],
  tokenBudget: number,
  omitted: AiOmittedContextRecord[],
): Promise<readonly RankedCandidate[]> {
  let remaining = tokenBudget;
  const selected: RankedCandidate[] = [];
  const rejected = new Set<string>();
  for (;;) {
    const selectedKeys = new Set(selected.map(candidateKey));
    let batchTokens = 0;
    const batch = ranked.filter((candidate) => {
      const key = candidateKey(candidate);
      if (selectedKeys.has(key) || rejected.has(key)) return false;
      if (batchTokens + candidate.tokenCount > remaining) return false;
      batchTokens += candidate.tokenCount;
      return true;
    });
    if (batch.length === 0) break;
    const authorizedKeys = new Set(
      (await repository.authorizeSelectedCandidates(scope, batch)).map(candidateKey),
    );
    for (const candidate of batch) {
      if (authorizedKeys.has(candidateKey(candidate))) {
        selected.push(candidate);
        remaining -= candidate.tokenCount;
      } else {
        rejected.add(candidateKey(candidate));
        omit(omitted, candidate, 'not_authorized', 'candidate failed pre-dispatch authorization');
      }
    }
  }
  const finalKeys = new Set([...selected.map(candidateKey), ...rejected]);
  for (const candidate of ranked) {
    if (!finalKeys.has(candidateKey(candidate))) {
      omit(omitted, candidate, 'token_budget', 'candidate did not fit remaining token budget');
    }
  }
  return Object.freeze(selected);
}

function score(candidate: AiContextCandidate, channel: AiContextChannel): number {
  const channelWeight = channel === 'lexical' ? 1_000 : channel === 'typed_relation' ? 800 : 650;
  const lexical = Math.round((candidate.lexicalScore ?? 0) * 100);
  const vector = Math.round((candidate.vectorScore ?? 0) * 80);
  const relation =
    candidate.relationDepth === undefined ? 0 : Math.max(0, 120 - candidate.relationDepth * 20);
  const verified = candidate.verified ? 150 : 0;
  const recency = Math.floor(Date.parse(candidate.updatedAt) / 86_400_000);
  const provenance = candidate.provenanceDigest === candidate.sourceDigest ? 50 : 0;
  return channelWeight + lexical + vector + relation + verified + recency + provenance;
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  return (
    right.score - left.score ||
    compareCanonicalText(right.updatedAt, left.updatedAt) ||
    compareCanonicalText(left.subjectId, right.subjectId) ||
    compareCanonicalText(left.revisionId, right.revisionId) ||
    compareCanonicalText(left.provenanceDigest, right.provenanceDigest)
  );
}

function compareOmissions(left: AiOmittedContextRecord, right: AiOmittedContextRecord): number {
  return (
    compareCanonicalText(left.subjectId, right.subjectId) ||
    compareCanonicalText(left.revisionId ?? '', right.revisionId ?? '') ||
    compareCanonicalText(left.reason, right.reason)
  );
}

function omit(
  omitted: AiOmittedContextRecord[],
  candidate: Partial<AiContextCandidate> & { readonly channels?: readonly AiContextChannel[] },
  reason: AiOmittedContextRecord['reason'],
  detail: string,
): void {
  omitted.push(
    Object.freeze({
      subjectId: typeof candidate.subjectId === 'string' ? candidate.subjectId : 'unknown',
      revisionId: typeof candidate.revisionId === 'string' ? candidate.revisionId : null,
      reason,
      channels: Object.freeze(candidate.channels ?? []),
      detail,
    }),
  );
}

function candidateKey(candidate: AiContextCandidate): string {
  return `${candidate.subjectId}\0${candidate.revisionId}`;
}

function toContextItem(candidate: AiContextCandidate): AiProposalRequest['context'][number] {
  return Object.freeze({
    subjectId: candidate.subjectId,
    revisionId: candidate.revisionId,
    classification: candidate.classification,
    kind: candidate.kind,
    content: candidate.content,
    tokenCount: candidate.tokenCount,
    provenanceDigest: candidate.provenanceDigest,
  });
}
