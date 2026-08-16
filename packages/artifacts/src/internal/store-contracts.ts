export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  /** Store version id, where versioning is enabled. */
  readonly versionId: string | undefined;
}

export interface ObjectStore {
  presignPut(key: string, mediaType: string, expiresInSeconds: number): Promise<string>;
  head(key: string, versionId?: string): Promise<StoredObject | undefined>;
  read(key: string, versionId?: string, maxBytes?: number): Promise<Buffer>;
  putIfAbsent(key: string, body: Buffer, mediaType: string): Promise<StoredObject>;
  put(key: string, body: Buffer, mediaType: string): Promise<StoredObject>;
}

export class ObjectReadLimitExceeded extends Error {
  readonly code = 'object_read_limit_exceeded';
  readonly key: string;
  readonly maxBytes: number;

  constructor(key: string, maxBytes: number) {
    super(`object ${key} exceeded read limit of ${String(maxBytes)} bytes`);
    this.name = 'ObjectReadLimitExceeded';
    this.key = key;
    this.maxBytes = maxBytes;
  }
}

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** MinIO and most self-hosted stores need path style; AWS does not. */
  readonly forcePathStyle?: boolean;
}

export function requireReadLimit(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
}
