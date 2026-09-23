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
