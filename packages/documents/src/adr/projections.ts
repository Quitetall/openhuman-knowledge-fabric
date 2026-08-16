import type {
  AdrActivityFact,
  AdrBodyLink,
  AdrDecisionRecord,
  AdrGateDebtProjection,
  AdrProjectionInput,
  AdrProjectionSet,
  AdrVerificationEvidence,
  CompiledAdrOverview,
} from './contracts.js';

const byRecordedAt = <T extends { readonly recordedAt: string }>(left: T, right: T): number =>
  left.recordedAt.localeCompare(right.recordedAt);

const topicKey = (decision: AdrDecisionRecord): string =>
  (decision.enterpriseId ?? decision.title).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

function acceptedBody(decisionId: string, bodies: readonly AdrBodyLink[]): AdrBodyLink | null {
  return (
    bodies
      .filter((body) => body.decisionId === decisionId && body.bodyState === 'accepted')
      .sort(byRecordedAt)
      .at(-1) ?? null
  );
}

function latestProgress(
  decisionId: string,
  activity: readonly AdrActivityFact[],
): AdrActivityFact | null {
  return (
    activity
      .filter((event) => event.decisionId === decisionId)
      .sort((left, right) => left.sequenceNo - right.sequenceNo)
      .at(-1) ?? null
  );
}

function gateDebt(evidence: AdrVerificationEvidence): AdrGateDebtProjection | null {
  if (evidence.executionState === 'passed') return null;
  const debtKind =
    evidence.testExecutionId === null
      ? 'missing_execution'
      : evidence.executionState === 'failed' || evidence.executionState === 'invalidated'
        ? evidence.executionState
        : 'not_passed';
  return {
    decisionId: evidence.decisionId,
    testDefinitionId: evidence.testDefinitionId,
    testExecutionId: evidence.testExecutionId,
    debtKind,
  };
}

function latestVerificationEvidence(
  verifications: readonly AdrVerificationEvidence[],
): readonly AdrVerificationEvidence[] {
  const latest = new Map<string, AdrVerificationEvidence>();
  for (const evidence of [...verifications].sort((left, right) => {
    const byTime = left.recordedAt.localeCompare(right.recordedAt);
    if (byTime !== 0) return byTime;
    return (left.testExecutionId ?? '').localeCompare(right.testExecutionId ?? '');
  })) {
    latest.set(`${evidence.decisionId}:${evidence.testDefinitionId}`, evidence);
  }
  return [...latest.values()];
}

function overviewFor(
  decision: AdrDecisionRecord,
  input: AdrProjectionInput,
  debt: readonly AdrGateDebtProjection[],
): CompiledAdrOverview {
  const body = acceptedBody(decision.decisionId, input.bodies);
  const progress = latestProgress(decision.decisionId, input.activity);
  return {
    decisionId: decision.decisionId,
    enterpriseId: decision.enterpriseId,
    title: decision.title,
    lifecycleState: decision.lifecycleState,
    acceptedDocumentRevisionId: body?.documentRevisionId ?? null,
    acceptedBodyDigest: body?.bodyDigest ?? null,
    latestProgressKind: progress?.progressKind ?? null,
    activityCount: input.activity.filter((event) => event.decisionId === decision.decisionId)
      .length,
    gateDebtCount: debt.filter((entry) => entry.decisionId === decision.decisionId).length,
  };
}

export function compileAdrProjections(input: AdrProjectionInput): AdrProjectionSet {
  const decisions = [...input.decisions].sort((left, right) =>
    left.decisionId.localeCompare(right.decisionId),
  );
  const gateDebtRows = latestVerificationEvidence(input.verifications)
    .map(gateDebt)
    .filter((entry): entry is AdrGateDebtProjection => entry !== null)
    .sort((left, right) =>
      `${left.decisionId}:${left.testDefinitionId}:${left.testExecutionId ?? ''}`.localeCompare(
        `${right.decisionId}:${right.testDefinitionId}:${right.testExecutionId ?? ''}`,
      ),
    );
  const overview = decisions.map((decision) => overviewFor(decision, input, gateDebtRows));
  const workBoard = overview.map((row) => {
    const activity = [
      ...input.bodies.filter((record) => record.decisionId === row.decisionId),
      ...input.implementations.filter((record) => record.decisionId === row.decisionId),
      ...input.activity.filter((record) => record.decisionId === row.decisionId),
      ...input.verifications.filter((record) => record.decisionId === row.decisionId),
      ...input.relations.filter((record) => record.sourceDecisionId === row.decisionId),
    ]
      .sort(byRecordedAt)
      .at(-1);
    return {
      decisionId: row.decisionId,
      title: row.title,
      lifecycleState: row.lifecycleState,
      latestProgressKind: row.latestProgressKind,
      implementationCount: input.implementations.filter(
        (link) => link.decisionId === row.decisionId,
      ).length,
      verificationCount: input.verifications.filter(
        (evidence) => evidence.decisionId === row.decisionId,
      ).length,
      lastActivityAt: activity?.recordedAt ?? null,
    };
  });
  return {
    overview,
    workBoard,
    digest: overview.map((row) => ({ ...row })),
    topics: overview.map((row) => ({
      decisionId: row.decisionId,
      topicKey: topicKey(row),
      title: row.title,
      lifecycleState: row.lifecycleState,
    })),
    gateDebt: gateDebtRows,
  };
}
