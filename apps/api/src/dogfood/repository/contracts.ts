export interface LegacyActionMaterialization extends Record<string, unknown> {
  readonly actionId: string;
  readonly requestDigest: string;
  readonly resultStatus: string;
  readonly resultAuditDigest: string | null;
  readonly actionType: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly targetIds: readonly string[];
  readonly effectiveAt: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
  readonly prevDigest: string;
  readonly auditDigest: string;
}

export interface DogfoodArtifactClaim {
  readonly title: string;
  readonly artifactKind: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly storageUri: string;
  readonly revisionLabel?: string;
  readonly requiresDocumentParse: boolean;
}

export interface DogfoodControlledDocumentClaim {
  readonly title: string;
  readonly documentClass: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly owningRole: string;
  readonly contentVersionId: string;
}

export interface LegacyArtifactMaterialization extends LegacyActionMaterialization {
  readonly artifactId: string;
  readonly versionId: string;
  readonly storageUri: string;
  readonly storageVersion: string | null;
}

export interface LegacyControlledDocumentMaterialization extends LegacyActionMaterialization {
  readonly documentId: string;
}

export interface CurrentFragmentSource extends Record<string, unknown> {
  readonly objectId: string;
  readonly holderId: string;
  readonly revisionHolderId: string;
  readonly holderKind: string;
  readonly artifactVersionId: string | null;
  readonly contentDigest: string;
  readonly revisionId: string;
  readonly mediaType: string;
  readonly classification: string;
}

export interface CurrentCompositionSource extends Record<string, unknown> {
  readonly objectId: string;
  readonly holderId: string;
  readonly revisionHolderId: string;
  readonly holderKind: string;
  readonly artifactVersionId: string | null;
  readonly contentDigest: string;
  readonly revisionId: string;
  readonly classification: string;
  readonly inputs: readonly CurrentCompositionInput[];
}

export interface CurrentCompositionInput extends Record<string, unknown> {
  readonly ordinal: number;
  readonly inputRole: string;
  readonly fragmentRevisionId: string | null;
}

export interface CurrentCompositionRow extends Record<string, unknown> {
  readonly objectId: string;
  readonly holderId: string;
  readonly revisionHolderId: string;
  readonly holderKind: string;
  readonly artifactVersionId: string | null;
  readonly contentDigest: string;
  readonly revisionId: string;
  readonly classification: string;
}
