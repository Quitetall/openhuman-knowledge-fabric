/**
 * The object store boundary.
 *
 * Narrow on purpose. Everything the evidence vault needs is here, and nothing that would
 * let a caller mutate an object in place — the store holds bytes that records have already
 * been signed against.
 */

import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  /** The store's own version id, where versioning is enabled. */
  readonly versionId: string | undefined;
}

export interface ObjectStore {
  /** A short-lived URL the client uploads to directly, so bytes never transit the API. */
  presignPut(key: string, mediaType: string, expiresInSeconds: number): Promise<string>;
  /** Metadata only — used to check an object arrived before paying to read it. */
  head(key: string): Promise<StoredObject | undefined>;
  /** Full bytes. Used to VERIFY a digest, never to serve content. */
  read(key: string, versionId?: string): Promise<Buffer>;
  put(key: string, body: Buffer, mediaType: string): Promise<StoredObject>;
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

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: S3Config) {
    const options: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.#client = new S3Client(options);
    this.#bucket = config.bucket;
  }

  async presignPut(key: string, mediaType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.#client,
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, ContentType: mediaType }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const r = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return { key, sizeBytes: r.ContentLength ?? 0, versionId: r.VersionId };
    } catch (err: unknown) {
      // A missing object is an expected outcome of "did the upload arrive", not an error.
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async read(key: string, versionId?: string): Promise<Buffer> {
    const r = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ...(versionId !== undefined ? { VersionId: versionId } : {}),
      }),
    );
    if (r.Body === undefined) throw new Error(`object ${key} has no body`);
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async put(key: string, body: Buffer, mediaType: string): Promise<StoredObject> {
    const r = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: mediaType,
      }),
    );
    return { key, sizeBytes: body.length, versionId: r.VersionId };
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

/** SHA-256 of raw bytes, lowercase hex. Never canonicalized — artifacts are bytes as they are. */
export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * An in-memory store for tests that exercise the flow rather than the transport.
 *
 * It is a real store in the ways that matter here: it holds distinct bytes per version and
 * returns exactly what was written, so a digest check against it is a genuine check.
 */
export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, { body: Buffer; mediaType: string; versionId: string }>();
  #counter = 0;

  async presignPut(key: string, _mediaType: string, _expiresInSeconds: number): Promise<string> {
    return `memory://${key}`;
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const o = this.#objects.get(key);
    return o === undefined ? undefined : { key, sizeBytes: o.body.length, versionId: o.versionId };
  }

  async read(key: string): Promise<Buffer> {
    const o = this.#objects.get(key);
    if (o === undefined) throw new Error(`object ${key} not found`);
    return o.body;
  }

  async put(key: string, body: Buffer, mediaType: string): Promise<StoredObject> {
    this.#counter += 1;
    const versionId = `v${this.#counter}`;
    this.#objects.set(key, { body, mediaType, versionId });
    return { key, sizeBytes: body.length, versionId };
  }

  /** Test-only: replace bytes at a key, simulating tampering in the store. */
  tamper(key: string, body: Buffer): void {
    const o = this.#objects.get(key);
    if (o === undefined) throw new Error(`object ${key} not found`);
    this.#objects.set(key, { ...o, body });
  }
}
