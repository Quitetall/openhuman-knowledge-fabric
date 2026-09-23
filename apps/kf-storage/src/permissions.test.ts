/**
 * The orphan-collection policy exists once as a shipped file and once in code; these hold them
 * equal, so the refusal kf-storage prints names exactly what the provisioning command applies.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUCKET_PLACEHOLDER,
  ORPHAN_POLICY_FILE,
  missingActions,
  orphanCollectionPolicy,
  orphanPermissionRefusal,
} from './permissions.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SHIPPED = join(ROOT, 'deploy', 'object-store', 'kf-storage-orphan-collection.policy.json');

describe('the orphan-collection policy', () => {
  it('is the shipped file, with the bucket substituted', () => {
    const shipped = readFileSync(SHIPPED, 'utf8').replaceAll(BUCKET_PLACEHOLDER, 'kf-artifacts');
    expect(JSON.parse(shipped)).toEqual(orphanCollectionPolicy('kf-artifacts'));
    expect(
      ORPHAN_POLICY_FILE.endsWith('deploy/object-store/kf-storage-orphan-collection.policy.json'),
    ).toBe(true);
  });

  it('grants deletion only under the evidence prefixes, never the whole bucket', () => {
    const text = JSON.stringify(orphanCollectionPolicy('kf-artifacts'));
    expect(text).toContain('arn:aws:s3:::kf-artifacts/ingest/*');
    expect(text).toContain('arn:aws:s3:::kf-artifacts/document-imports/*');
    expect(text).not.toContain('arn:aws:s3:::kf-artifacts/*');
  });

  it('names what is missing, on which key and bucket, and how to grant it', () => {
    const missing = missingActions({
      listBucket: true,
      listBucketVersions: false,
      deleteObjectVersion: false,
    });
    expect(missing).toEqual(['s3:ListBucketVersions', 's3:DeleteObjectVersion']);
    const message = orphanPermissionRefusal(
      { bucket: 'kf-artifacts', accessKeyId: 'kf-storage-key' },
      missing,
    );
    for (const part of [
      'kf-storage-key',
      'kf-artifacts',
      's3:ListBucketVersions and s3:DeleteObjectVersion',
      ORPHAN_POLICY_FILE,
      'sudo /opt/kf/scripts/deploy/provision-host.sh --check',
    ]) {
      expect(message).toContain(part);
    }
  });
});
