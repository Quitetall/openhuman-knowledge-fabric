/**
 * What the working-store key must be allowed to do for orphan collection, and what to say when
 * it is not.
 *
 * `--collect-orphans` lists every version of an evidence key and deletes them. A key without
 * s3:ListBucketVersions and s3:DeleteObjectVersion fails every run, and it should stay loud —
 * but until 2026-09-23 the failure was the store's own "Access Denied." with nothing to say
 * which permission, on which bucket, or how to grant it. The policy is shipped as a file
 * (`deploy/object-store/kf-storage-orphan-collection.policy.json`) that the provisioning
 * command applies; this module is the same policy in code, held equal to the file by a test,
 * so the message can name exactly what the file grants.
 */

import type { CollectionPermissions } from '@kf/artifacts';
import { EVIDENCE_NAMESPACES } from './orphans.js';

export const ORPHAN_POLICY_NAME = 'kf-storage-orphan-collection';
/** Where the release carries the policy, with `KF_ARTIFACTS_BUCKET` standing for the bucket. */
export const ORPHAN_POLICY_FILE =
  '/opt/kf/deploy/object-store/kf-storage-orphan-collection.policy.json';
export const BUCKET_PLACEHOLDER = 'KF_ARTIFACTS_BUCKET';
export const PROVISION_COMMAND = 'sudo /opt/kf/scripts/deploy/provision-host.sh';

export function orphanCollectionPolicy(bucket: string): unknown {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'KfStorageListEvidence',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:ListBucketVersions'],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Sid: 'KfStorageCollectOrphanedEvidence',
        Effect: 'Allow',
        Action: ['s3:DeleteObjectVersion'],
        Resource: EVIDENCE_NAMESPACES.map((namespace) => `arn:aws:s3:::${bucket}/${namespace}/*`),
      },
    ],
  };
}

const ACTION_BY_PERMISSION: Record<keyof CollectionPermissions, string> = {
  listBucket: 's3:ListBucket',
  listBucketVersions: 's3:ListBucketVersions',
  deleteObjectVersion: 's3:DeleteObjectVersion',
};

export function missingActions(permissions: CollectionPermissions): string[] {
  return (Object.keys(ACTION_BY_PERMISSION) as (keyof CollectionPermissions)[])
    .filter((permission) => !permissions[permission])
    .map((permission) => ACTION_BY_PERMISSION[permission]);
}

/**
 * The refusal an operator can act on: which key, which bucket, which permissions, which policy,
 * and the command that applies it. Every value is non-secret — an access-key ID and a bucket.
 */
export function orphanPermissionRefusal(
  store: { readonly bucket: string; readonly accessKeyId: string },
  missing: readonly string[] = ['s3:ListBucketVersions', 's3:DeleteObjectVersion'],
): string {
  return (
    `orphan collection refused: the working-store key ${store.accessKeyId} lacks ` +
    `${missing.join(' and ')} on bucket ${store.bucket}. Grant it the policy ` +
    `${ORPHAN_POLICY_NAME} (${ORPHAN_POLICY_FILE}, with ${BUCKET_PLACEHOLDER} replaced by ` +
    `${store.bucket}). \`${PROVISION_COMMAND}\` applies it when \`mc\` has an admin alias for ` +
    `the store and prints it otherwise; \`${PROVISION_COMMAND} --check\` confirms it took.`
  );
}
