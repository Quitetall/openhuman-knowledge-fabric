/**
 * Whether the buckets the Knowledge Fabric writes to have S3 versioning in effect.
 *
 * Versioning is not an optimisation here. The artifact store records each object's version id
 * (`content.artifact_location.store_version`) and reads by it, so a location names THE bytes a
 * record was signed against rather than whatever is at that key now. On a bucket without
 * versioning, the store answers with no version id, a second write to a key destroys the first,
 * and nothing says so. ADR 0039 chose the working store (SeaweedFS) partly because it implements
 * versioning; a store whose GetBucketVersioning answers "not enabled" whatever it was told
 * (Garage) was rejected for exactly that.
 *
 * The check reads what the store SAYS, per bucket. Only an explicit `Enabled` passes: a bucket
 * that was never versioned answers with no status at all, and `Suspended` stops new versions.
 */

import { GetBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Config } from './internal/store-contracts.js';

export type BucketVersioning = 'Enabled' | 'Suspended' | 'never enabled';

/** What the store answers for each bucket, in the order asked. Errors propagate. */
export async function bucketVersioning(
  config: Omit<S3Config, 'bucket'>,
  buckets: readonly string[],
): Promise<ReadonlyMap<string, BucketVersioning>> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle ?? true,
  });
  try {
    const answers = new Map<string, BucketVersioning>();
    for (const bucket of buckets) {
      const { Status } = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      answers.set(
        bucket,
        Status === 'Enabled' || Status === 'Suspended' ? Status : 'never enabled',
      );
    }
    return answers;
  } finally {
    client.destroy();
  }
}

export class VersioningNotEnabled extends Error {
  readonly code = 'object_store_versioning_not_enabled';

  constructor(readonly buckets: ReadonlyMap<string, BucketVersioning>) {
    super(
      `object store versioning is not in effect: ${[...buckets]
        .map(([bucket, status]) => `bucket ${bucket} is ${status}`)
        .join('; ')}. Every bucket must answer GetBucketVersioning with Enabled before anything ` +
        'is written to it (deploy/object-store/init-buckets.sh enables and checks it).',
    );
    this.name = 'VersioningNotEnabled';
  }
}

/** Refuse, naming every offending bucket, unless each of `buckets` answers `Enabled`. */
export async function requireVersioning(
  config: Omit<S3Config, 'bucket'>,
  buckets: readonly string[],
): Promise<void> {
  const answers = await bucketVersioning(config, buckets);
  const offending = new Map([...answers].filter(([, status]) => status !== 'Enabled'));
  if (offending.size > 0) throw new VersioningNotEnabled(offending);
}
