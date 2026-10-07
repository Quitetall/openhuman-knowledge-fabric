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
  /** SeaweedFS and most self-hosted stores need path style; AWS does not. */
  readonly forcePathStyle?: boolean;
  /**
   * Whether `putIfAbsent` asks the store to refuse an existing key (`If-None-Match: *`). True by
   * default. False for a store that does not implement conditional writes — Backblaze B2 does
   * not document them — where it checks for the key first and then writes: not atomic, so two
   * writers racing the same key can both write, which for a content-addressed copy of the same
   * verified bytes leaves two identical versions and keeps the first one recorded.
   */
  readonly conditionalCreate?: boolean;
}

export function requireReadLimit(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
}
