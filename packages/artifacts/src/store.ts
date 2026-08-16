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
import {
  ObjectReadLimitExceeded,
  requireReadLimit,
  type ObjectStore,
  type S3Config,
  type StoredObject,
} from './internal/store-contracts.js';

export {
  ObjectReadLimitExceeded,
  type ObjectStore,
  type S3Config,
  type StoredObject,
} from './internal/store-contracts.js';
export { InMemoryObjectStore } from './internal/memory-store.js';

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

  async head(key: string, versionId?: string): Promise<StoredObject | undefined> {
    try {
      const r = await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(versionId !== undefined ? { VersionId: versionId } : {}),
        }),
      );
      return { key, sizeBytes: r.ContentLength ?? 0, versionId: r.VersionId };
    } catch (err: unknown) {
      // A missing object is an expected outcome of "did the upload arrive", not an error.
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async read(key: string, versionId?: string, maxBytes?: number): Promise<Buffer> {
    requireReadLimit(maxBytes);
    const abortController = new AbortController();
    const r = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ...(versionId !== undefined ? { VersionId: versionId } : {}),
      }),
      { abortSignal: abortController.signal },
    );
    if (r.Body === undefined) throw new Error(`object ${key} has no body`);
    if (maxBytes !== undefined && (r.ContentLength ?? 0) > maxBytes) {
      abortStreamingBody(r.Body, abortController);
      throw new ObjectReadLimitExceeded(key, maxBytes);
    }

    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    for await (const chunk of r.Body as AsyncIterable<unknown>) {
      const bytes = bodyChunk(chunk);
      if (bytes.byteLength === 0) continue;
      if (maxBytes !== undefined && bytes.byteLength > maxBytes - sizeBytes) {
        abortStreamingBody(r.Body, abortController);
        throw new ObjectReadLimitExceeded(key, maxBytes);
      }
      sizeBytes += bytes.byteLength;
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, sizeBytes);
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

  async putIfAbsent(key: string, body: Buffer, mediaType: string): Promise<StoredObject> {
    const maxAttempts = 3;
    let lastConflict: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const r = await this.#client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: body,
            ContentType: mediaType,
            IfNoneMatch: '*',
          }),
        );
        return { key, sizeBytes: body.length, versionId: r.VersionId };
      } catch (error: unknown) {
        if (!isConditionalWriteConflict(error)) throw error;
        lastConflict = error;
      }

      const existing = await this.head(key);
      if (existing !== undefined) return existing;
      // 409 requires retry. A 412 followed by no HEAD means the winning object was deleted;
      // retrying the same conditional create remains safe and preserves create-only semantics.
    }
    throw new Error(`object ${key} remained unavailable after conditional create conflicts`, {
      cause: lastConflict,
    });
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.name === 'NoSuchVersion' ||
    e.$metadata?.httpStatusCode === 404
  );
}

function isConditionalWriteConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'PreconditionFailed' ||
    e.name === 'ConditionalRequestConflict' ||
    e.$metadata?.httpStatusCode === 412 ||
    e.$metadata?.httpStatusCode === 409
  );
}

function bodyChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('object store returned a non-byte body chunk');
}

function abortStreamingBody(body: unknown, abortController: AbortController): void {
  const stream = body as { destroy?: () => void };
  // Cleanup is best-effort. A transport-specific cleanup failure must not replace the stable
  // ObjectReadLimitExceeded result that caused cleanup in the first place.
  try {
    abortController.abort();
  } catch {
    // Limit error remains authoritative.
  }
  try {
    stream.destroy?.();
  } catch {
    // Limit error remains authoritative.
  }
}

/** SHA-256 of raw bytes, lowercase hex. Never canonicalized — artifacts are bytes as they are. */
export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
