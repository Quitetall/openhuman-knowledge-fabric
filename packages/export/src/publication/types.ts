export interface PublicationFile {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface PublicationManifest {
  readonly format_version: 'kf-publication-v1';
  readonly publication_id: string;
  readonly publication_action_id: string;
  readonly acceptance_action_id: string;
  readonly controlled_revision_id: string;
  readonly controlled_content_version_id: string;
  readonly compiled_view_id: string;
  readonly compiled_view_digest: string;
  readonly compiled_view_media_type: string;
  readonly publication_target_id: string;
  readonly publication_target_policy_digest: string;
  readonly classification: 'public';
  readonly lifecycle_state: 'effective';
  readonly published_at: string;
  readonly files: readonly {
    readonly path: string;
    readonly media_type: string;
    readonly size_bytes: number;
    readonly sha256: string;
  }[];
}

export interface PublicationSignature {
  readonly algorithm: 'Ed25519';
  readonly key_id: string;
  readonly value_base64: string;
}

export interface SignedPublicationBundle {
  readonly manifest: PublicationManifest;
  readonly signature: PublicationSignature;
  readonly files: readonly PublicationFile[];
}

export interface AuthorizedPublicationProjection {
  readonly publicationId: string;
  readonly publicationActionId: string;
  readonly acceptanceActionId: string;
  readonly controlledRevisionId: string;
  readonly controlledContentVersionId: string;
  readonly compiledViewId: string;
  readonly compiledViewDigest: string;
  readonly compiledViewMediaType: string;
  readonly publicationTargetId: string;
  readonly publicationTargetPolicyDigest: string;
  readonly classification: 'public';
  readonly lifecycleState: 'effective';
  readonly publishedAt: string;
}

export interface PublicationProjectionRequest {
  readonly publicationId: string;
  readonly controlledRevisionId: string;
  readonly compiledViewId: string;
}
