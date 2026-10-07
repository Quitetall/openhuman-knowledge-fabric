#!/usr/bin/env node
/**
 * Copy a fixture stack's object store from MinIO to SeaweedFS (ADR 0039) KEEPING EVERY VERSION ID.
 *
 *   node migrate-objects.mjs copy   <bucket>...   copy what the target lacks (resumable)
 *   node migrate-objects.mjs verify <bucket>...   re-read every source version from the target
 *
 *   KF_MIGRATE_SOURCE   the MinIO S3 endpoint        e.g. http://127.0.0.1:19100
 *   KF_MIGRATE_TARGET   the SeaweedFS S3 endpoint    e.g. http://127.0.0.1:29200
 *   KF_MIGRATE_FILER    the SeaweedFS filer          e.g. http://127.0.0.1:29288
 *   the development credentials (both stores use docker-compose.yml's public values).
 *
 * WHY THE VERSION IDS MUST SURVIVE. Every artifact version records the store's version id
 * (`content.artifact_version.storage_version`, mirrored in `content.artifact_location`), and both
 * rows are append-only: the database refuses to change them. Reads go by that id. A copy that
 * gave each object a new id would leave every record naming a version the store does not have.
 *
 * HOW. S3 has no way to choose a version id, so each version is written through the S3 API (which
 * makes the bytes, chunks, ETag and metadata exactly as any upload would), then renamed in
 * SeaweedFS's filer to the id MinIO gave it: a version is the file `<key>.versions/v_<id>` with the
 * id in its `Seaweed-X-Amz-Version-Id` attribute, and `<key>.versions` names the latest. Versions
 * are written oldest first, so the latest is written last and the directory's cached latest
 * metadata (size, ETag) is the latest's; its pointer is then set to the latest's original id.
 *
 * NOTHING IS TRUSTED THAT IS NOT READ BACK. `copy` skips a version only when the target already
 * answers HEAD for its ORIGINAL id with the same size. `verify` reads every source version and its
 * namesake from the target, by id, and compares sha256; any difference, absence or a delete
 * marker (which this does not copy) is reported and exits 1.
 *
 * A one-off for the owner's workstation stacks, kept so the move is reproducible. It never
 * deletes or changes anything in the source.
 */

/* global fetch -- Node 24's, as the evidence scripts use it (eslint.config.js). */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  fileURLToPath(new URL('../../../packages/artifacts/package.json', import.meta.url)),
);
const {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');

const [command, ...buckets] = process.argv.slice(2);
const source = required('KF_MIGRATE_SOURCE');
const target = required('KF_MIGRATE_TARGET');
const filer = required('KF_MIGRATE_FILER').replace(/\/$/, '');
const CONCURRENCY = Number(process.env['KF_MIGRATE_CONCURRENCY'] ?? '8');

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function client(endpoint) {
  return new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'kf-dev-access-key', secretAccessKey: 'dev-only-not-a-secret' },
    forcePathStyle: true,
  });
}
const from = client(source);
const to = client(target);

async function body(response) {
  return Buffer.from(await response.Body.transformToByteArray());
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every version and delete marker in `bucket`, grouped by key, oldest first. */
async function inventory(bucket) {
  const keys = new Map();
  const markers = [];
  let keyMarker;
  let versionMarker;
  do {
    const page = await from.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
      }),
    );
    for (const version of page.Versions ?? []) {
      const list = keys.get(version.Key) ?? [];
      list.push(version);
      keys.set(version.Key, list);
    }
    for (const marker of page.DeleteMarkers ?? [])
      markers.push(`${marker.Key}@${marker.VersionId}`);
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  for (const list of keys.values()) {
    list.sort((a, b) => a.LastModified.getTime() - b.LastModified.getTime());
    if (list.at(-1)?.IsLatest !== true) {
      throw new Error(
        `${list[0].Key}: the newest version by time is not the one MinIO calls latest`,
      );
    }
  }
  return { keys, markers };
}

function filerPath(bucket, key) {
  return `/buckets/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function filerCall(method, path, headers = {}) {
  const response = await fetch(`${filer}${path}`, { method, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`filer ${method} ${path}: ${response.status} ${text}`);
}

async function present(bucket, key, versionId, size) {
  try {
    const head = await to.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    );
    return head.ContentLength === size;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.$metadata?.httpStatusCode === 400) {
      return false;
    }
    throw error;
  }
}

async function copyKey(bucket, key, versions, counts) {
  if (
    (await Promise.all(versions.map((v) => present(bucket, key, v.VersionId, v.Size)))).every(
      Boolean,
    )
  ) {
    counts.skipped += versions.length;
    return;
  }
  // A key is copied whole, oldest first: a partly copied key (an interrupted run) is redone.
  const dir = `${filerPath(bucket, key)}.versions`;
  for (const version of versions) {
    if (await present(bucket, key, version.VersionId, version.Size)) continue;
    const got = await from.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version.VersionId }),
    );
    const bytes = await body(got);
    const put = await to.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: got.ContentType,
      }),
    );
    if (put.VersionId === undefined)
      throw new Error(`${bucket}/${key}: the target is not versioned`);
    await filerCall(
      'POST',
      `${dir}/v_${version.VersionId}?mv.from=${encodeURIComponent(`${dir}/v_${put.VersionId}`)}`,
    );
    await filerCall('PUT', `${dir}/v_${version.VersionId}?tagging`, {
      'Seaweed-X-Amz-Version-Id': version.VersionId,
    });
    counts.copied += 1;
    counts.bytes += bytes.length;
  }
  const latest = versions.at(-1).VersionId;
  await filerCall('PUT', `${dir}?tagging`, {
    'Seaweed-X-Amz-Latest-Version-Id': latest,
    'Seaweed-X-Amz-Latest-Version-File-Name': `v_${latest}`,
  });
}

async function verifyKey(bucket, key, versions, counts, failures) {
  for (const version of versions) {
    try {
      const [a, b] = await Promise.all([
        from.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version.VersionId })),
        to.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version.VersionId })),
      ]);
      const [expected, actual] = [sha(await body(a)), sha(await body(b))];
      if (b.VersionId !== version.VersionId) {
        failures.push(`${bucket}/${key}@${version.VersionId}: target answered as ${b.VersionId}`);
      } else if (expected !== actual) {
        failures.push(
          `${bucket}/${key}@${version.VersionId}: sha256 ${actual}, source ${expected}`,
        );
      } else {
        counts.verified += 1;
      }
    } catch (error) {
      failures.push(
        `${bucket}/${key}@${version.VersionId}: ${error?.name ?? ''} ${error?.message ?? error}`,
      );
    }
  }
  // The unversioned read must answer the latest, as MinIO did.
  const head = await to.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.VersionId !== versions.at(-1).VersionId) {
    failures.push(
      `${bucket}/${key}: latest is ${head.VersionId}, source ${versions.at(-1).VersionId}`,
    );
  }
}

async function pool(items, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

if (!['copy', 'verify'].includes(command) || buckets.length === 0) {
  process.stderr.write('usage: migrate-objects.mjs copy|verify <bucket>...\n');
  process.exit(64);
}
let failed = false;
for (const bucket of buckets) {
  const { keys, markers } = await inventory(bucket);
  const versions = [...keys.values()].reduce((sum, list) => sum + list.length, 0);
  const counts = { copied: 0, skipped: 0, bytes: 0, verified: 0 };
  const failures = [];
  const started = Date.now();
  await pool([...keys.entries()], ([key, list]) =>
    command === 'copy'
      ? copyKey(bucket, key, list, counts)
      : verifyKey(bucket, key, list, counts, failures),
  );
  for (const marker of markers) failures.push(`${bucket}: delete marker ${marker} not copied`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    command === 'copy'
      ? `${bucket}: ${keys.size} keys, ${versions} versions; copied ${counts.copied} (${counts.bytes} bytes), already present ${counts.skipped}, in ${seconds}s\n`
      : `${bucket}: ${keys.size} keys, ${versions} versions; verified ${counts.verified}, failed ${failures.length}, in ${seconds}s\n`,
  );
  for (const failure of failures.slice(0, 50)) process.stdout.write(`  FAIL ${failure}\n`);
  if (failures.length > 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
