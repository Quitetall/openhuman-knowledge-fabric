export type AdrDecisionState =
  'draft' | 'proposed' | 'accepted' | 'rejected' | 'superseded' | 'withdrawn';

export interface AdrDecisionRecord {
  readonly decisionId: string;
  readonly enterpriseId: string | null;
  readonly title: string;
  readonly lifecycleState: AdrDecisionState;
}

export interface AdrBodyLink {
  readonly decisionId: string;
  readonly documentRevisionId: string;
  readonly bodyState: 'draft' | 'accepted';
  readonly bodyDigest: string;
  readonly recordedAt: string;
}

export interface AdrImplementationLink {
  readonly decisionId: string;
  readonly implementationKind: 'change' | 'work_execution';
  readonly targetId: string;
  readonly summary: string;
  readonly recordedAt: string;
}

export interface AdrActivityFact {
  readonly decisionId: string;
  readonly sequenceNo: number;
  readonly progressKind: 'progress' | 'blocked' | 'completed' | 'rejected' | 'falsified';
  readonly summary: string;
  readonly recordedAt: string;
}

export interface AdrVerificationEvidence {
  readonly decisionId: string;
  readonly testDefinitionId: string;
  readonly testExecutionId: string | null;
  readonly executionState: 'not_run' | 'passed' | 'failed' | 'invalidated' | 'other';
  readonly recordedAt: string;
}

export interface AdrRelationLink {
  readonly sourceDecisionId: string;
  readonly targetDecisionId: string;
  readonly relationKind: 'supersedes' | 'amends' | 'extends';
  readonly recordedAt: string;
}

export interface AdrProjectionInput {
  readonly decisions: readonly AdrDecisionRecord[];
  readonly bodies: readonly AdrBodyLink[];
  readonly implementations: readonly AdrImplementationLink[];
  readonly activity: readonly AdrActivityFact[];
  readonly verifications: readonly AdrVerificationEvidence[];
  readonly relations: readonly AdrRelationLink[];
}

export interface CompiledAdrOverview {
  readonly decisionId: string;
  readonly enterpriseId: string | null;
  readonly title: string;
  readonly lifecycleState: AdrDecisionState;
  readonly acceptedDocumentRevisionId: string | null;
  readonly acceptedBodyDigest: string | null;
  readonly latestProgressKind: AdrActivityFact['progressKind'] | null;
  readonly activityCount: number;
  readonly gateDebtCount: number;
}

export interface AdrWorkBoardProjection {
  readonly decisionId: string;
  readonly title: string;
  readonly lifecycleState: AdrDecisionState;
  readonly latestProgressKind: AdrActivityFact['progressKind'] | null;
  readonly implementationCount: number;
  readonly verificationCount: number;
  readonly lastActivityAt: string | null;
}

export interface AdrTopicProjection {
  readonly decisionId: string;
  readonly topicKey: string;
  readonly title: string;
  readonly lifecycleState: AdrDecisionState;
}

export interface AdrGateDebtProjection {
  readonly decisionId: string;
  readonly testDefinitionId: string;
  readonly testExecutionId: string | null;
  readonly debtKind: 'missing_execution' | 'failed' | 'invalidated' | 'not_passed';
}

export interface AdrProjectionSet {
  readonly overview: readonly CompiledAdrOverview[];
  readonly workBoard: readonly AdrWorkBoardProjection[];
  readonly digest: readonly Readonly<Record<string, unknown>>[];
  readonly topics: readonly AdrTopicProjection[];
  readonly gateDebt: readonly AdrGateDebtProjection[];
}
