// Single-PUT operating budget, not a promise of multipart/large-corpus support.
export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024;

export interface B2ArchiveConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly applicationKeyId: string;
  readonly applicationKey: string;
}
/** Provider identity is transport evidence, not a signed manifest or physical-domain approval. */
export interface OffsiteArchiveCopy {
  readonly format: 'kf-offsite-object-v1';
  readonly endpoint: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface OffsiteArchiveStore {
  /** Requires an authenticated backup builder's ciphertext; packet framing is not authentication. */
  publish(path: string, signal?: AbortSignal): Promise<OffsiteArchiveCopy>;
  /** Requires a trusted recorded identity and a nonexistent file in an owned canonical 0700 directory. */
  pull(copy: OffsiteArchiveCopy, path: string, signal?: AbortSignal): Promise<void>;
  close(): void;
}
export class OffsiteTransferRefused extends Error {
  readonly code = 'offsite_transfer_refused';
  constructor() {
    super('off-site ciphertext transfer refused');
    this.name = 'OffsiteTransferRefused';
  }
}
export function refuse(): never {
  throw new OffsiteTransferRefused();
}
export function version(value: unknown): string {
  if (typeof value !== 'string' || value === 'null' || !/^[\x21-\x7e]{1,1024}$/.test(value))
    refuse();
  return value;
}
export function validateCopy(copy: OffsiteArchiveCopy, endpoint: string, bucket: string): void {
  if (
    copy.format !== 'kf-offsite-object-v1' ||
    copy.endpoint !== endpoint ||
    copy.bucket !== bucket ||
    !/^[a-f0-9]{64}$/.test(copy.sha256) ||
    copy.key !== `kf-backups/v1/${copy.sha256}.tar.gpg` ||
    !Number.isSafeInteger(copy.sizeBytes) ||
    copy.sizeBytes < 1 ||
    copy.sizeBytes > MAX_ARCHIVE_BYTES
  )
    refuse();
  version(copy.versionId);
}
