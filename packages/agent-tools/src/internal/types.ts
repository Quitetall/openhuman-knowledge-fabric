import type { RecordVerification } from '@kf/domain';

export interface AgentScope {
  readonly organizationId: string;
  readonly maxClassification: string;
  /** Who the agent is acting for. Every read is scoped as that person, never as the agent. */
  readonly actorId: string;
  readonly actingRoleId: string;
  /** That person's attestation that they are present (20260924001000); see `Principal`. */
  readonly attestation?: string | undefined;
}

export interface ObjectSummary {
  readonly id: string;
  readonly enterpriseId: string | null;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rowVersion: string;
  readonly createdAt: string;
  /**
   * Whether anybody has verified this record (`core.object_verification`, KF-SAS-RQ-228 to
   * RQ-232), with the label a reader is shown. An agent's context says a record is unverified
   * in the same words a person's page does; an unverified record is not evidence (RQ-230).
   * Not to be confused with `verification_of`, which reports test verification of a subject.
   */
  readonly verification: RecordVerification;
}

export interface HistoryEntry {
  readonly seq: string;
  readonly actionType: string;
  readonly actorId: string;
  readonly recordedAt: string;
  readonly reason: string | null;
}

export interface AvailableAction {
  readonly actionType: string;
  readonly toStates: readonly string[];
  readonly requiresChoice: boolean;
}

export interface TracedEdge {
  readonly relationType: string;
  readonly fromId: string;
  readonly toId: string;
  readonly toTitle: string;
  readonly toType: string;
  readonly depth: number;
  /** Whether anybody has verified the record this edge reaches (see `ObjectSummary`). */
  readonly toVerification: RecordVerification;
}

export interface VerificationSummary {
  readonly subjectId: string;
  readonly verified: boolean;
  readonly approvedDefinitions: number;
  readonly definitionsPassed: number;
  readonly failed: number;
  readonly invalidated: number;
  readonly unexecuted: number;
}

export interface ExternalCitation {
  readonly source: string;
  readonly repository: string;
  readonly externalId: string;
  readonly commitSha: string;
  readonly path: string;
  readonly contentSha256: string;
  readonly linkKind: string;
}

export interface EvidenceItem {
  readonly versionId: string;
  readonly artifactId: string;
  readonly versionNo: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: string;
}
