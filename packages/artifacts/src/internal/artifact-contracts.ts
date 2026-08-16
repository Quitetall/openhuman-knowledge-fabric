export type VerificationFailure =
  'not_uploaded' | 'digest_mismatch' | 'size_mismatch' | 'empty_object' | 'unversioned_storage';

export class ArtifactRejected extends Error {
  readonly failure: VerificationFailure;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(failure: VerificationFailure, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ArtifactRejected';
    this.failure = failure;
    this.detail = detail;
  }
}

export interface UploadTicket {
  readonly key: string;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface VerifiedUpload {
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageVersion: string;
}
