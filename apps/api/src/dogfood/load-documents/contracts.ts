import type { LoadedDogfoodDocument } from '../contracts.js';

export interface LoadedArtifact {
  readonly artifactId: string;
  readonly versionId: string;
  readonly replayed: boolean;
}

export interface LoadedFragment {
  readonly fragmentId: string;
  readonly fragmentRevisionId: string;
  readonly replayed: boolean;
}

export interface LoadedControlledDocument {
  readonly documentId: string;
  readonly replayed: boolean;
}

export interface LoadedSourceResult {
  readonly loaded: LoadedDogfoodDocument;
  readonly fragmentRevisionId: string;
}
