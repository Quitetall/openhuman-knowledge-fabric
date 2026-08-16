import type { ActionRequest, ActionResult } from '@kf/actions';
import type { Tx } from '@kf/database';

export interface ManifestEntry {
  readonly file: string;
  readonly title: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentClass: string;
  readonly owningRole: string;
}

export interface StagedSource {
  readonly entry: ManifestEntry;
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly sha256: string;
  readonly key: string;
}

export interface StagedManifest {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly key: string;
  readonly fileName: string;
}

export interface StagedConstitution {
  readonly sources: readonly StagedSource[];
  readonly manifest: StagedManifest;
}

export interface DogfoodIdentity {
  readonly organizationId: string;
  readonly actorId: string;
  readonly actingRoleId: string;
}

export interface DogfoodActionContext {
  readonly organizationId: string;
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly maxClassification: string;
  readonly targetIds: readonly string[];
  readonly requestId: string;
}

export type DogfoodExecute = (tx: Tx, request: ActionRequest) => Promise<ActionResult>;

export interface LoadedDogfoodDocument {
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentId: string;
  readonly artifactId: string;
  readonly fragmentId: string;
  readonly fragmentRevisionId: string;
  readonly sha256: string;
  readonly replayed: boolean;
}

export interface LoadedDogfoodComposition {
  readonly compositionId: string;
  readonly compositionRevisionId: string;
  readonly manifestArtifactId: string;
  readonly manifestSha256: string;
  readonly replayed: boolean;
}
