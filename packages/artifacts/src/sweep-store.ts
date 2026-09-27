/**
 * The only object-store surface that can remove bytes, kept apart from `ObjectStore` on
 * purpose.
 *
 * `ObjectStore` is narrow so that nothing holding one can mutate or delete an object records
 * were signed against. Orphan collection still needs a delete: an ingest that stores bytes
 * and is then refused leaves an object nothing references. So the capability lives here, is
 * constructed only by the storage sweep (`apps/kf-storage`), and its callers decide what is
 * unreferenced — this class decides nothing.
 */

import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Config } from './internal/store-contracts.js';

export interface ListedObject {
  readonly key: string;
  readonly lastModified: Date;
}

/**
 * Whether an S3 error is the store refusing this credential — as opposed to the object or the
 * network. The SDK names the error after the S3 code; the status covers stores that do not.
 */
export function isAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const shaped = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    shaped.name === 'AccessDenied' ||
    shaped.Code === 'AccessDenied' ||
    shaped.$metadata?.httpStatusCode === 403
  );
}

/** What a credential may do for orphan collection, measured without removing anything. */
export interface CollectionPermissions {
  /** s3:ListBucket — listing current objects under the evidence prefixes. */
  readonly listBucket: boolean;
  /** s3:ListBucketVersions — finding every version of a key. */
  readonly listBucketVersions: boolean;
  /** s3:DeleteObjectVersion — removing a version, not only hiding it behind a marker. */
  readonly deleteObjectVersion: boolean;
}

export interface SweepableObjectStore {
  /** Current objects under `prefix`, with the time their current version was written. */
  list(prefix: string): AsyncIterable<ListedObject>;
  /** Remove every version and delete marker of exactly `key`. Returns how many were removed. */
  deleteEveryVersion(key: string): Promise<number>;
}

export class S3SweepableObjectStore implements SweepableObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: S3Config) {
    this.#client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: config.forcePathStyle ?? true,
    });
    this.#bucket = config.bucket;
  }

  async *list(prefix: string): AsyncIterable<ListedObject> {
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined || object.LastModified === undefined) continue;
        yield { key: object.Key, lastModified: object.LastModified };
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  /**
   * Ask the store whether this credential may list, list versions and delete versions under
   * `prefix`, without touching any object. The delete names a random key that does not exist,
   * with an explicit version: authorization is decided before existence, so a refusal is
   * `AccessDenied` and anything else — success, or "no such version" — means permitted. An
   * explicit-version delete never writes a delete marker, so a permitted probe changes nothing.
   */
  async probeCollectionPermissions(prefix: string): Promise<CollectionPermissions> {
    const permitted = async (
      probe: () => Promise<unknown>,
      objectAnswerMeansPermitted = false,
    ): Promise<boolean> => {
      try {
        await probe();
        return true;
      } catch (error: unknown) {
        if (isAccessDenied(error)) return false;
        const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
          ?.httpStatusCode;
        // For the delete, a 4xx other than 403 is the store answering about the (absent)
        // object, which it does only after authorizing. A list has no such excuse: a missing
        // bucket is a failure to report, not a permission to claim.
        if (
          objectAnswerMeansPermitted &&
          typeof status === 'number' &&
          status >= 400 &&
          status < 500
        ) {
          return true;
        }
        throw error;
      }
    };
    return {
      listBucket: await permitted(() =>
        this.#client.send(
          new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: 1 }),
        ),
      ),
      listBucketVersions: await permitted(() =>
        this.#client.send(
          new ListObjectVersionsCommand({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: 1 }),
        ),
      ),
      deleteObjectVersion: await permitted(
        () =>
          this.#client.send(
            new DeleteObjectCommand({
              Bucket: this.#bucket,
              Key: `${prefix}kf-permission-probe-${randomUUID()}`,
              VersionId: 'null',
            }),
          ),
        true,
      ),
    };
  }

  async deleteEveryVersion(key: string): Promise<number> {
    // A plain DELETE on a versioned bucket only adds a delete marker; the bytes stay as a
    // noncurrent version. Collecting an orphan means removing the versions themselves.
    // `Prefix` matches longer keys too, so every entry is filtered to exactly this key.
    let removed = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          Prefix: key,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
        }),
      );
      const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
      for (const entry of entries) {
        if (entry.Key !== key) continue;
        await this.#client.send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            VersionId: entry.VersionId ?? 'null',
          }),
        );
        removed += 1;
      }
      const more = page.IsTruncated === true;
      keyMarker = more ? page.NextKeyMarker : undefined;
      versionMarker = more ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined);
    return removed;
  }
}
