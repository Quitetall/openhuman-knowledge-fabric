#!/usr/bin/env node
/** Exercise the actual development Compose store without sharing names, ports or volumes. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = `kf-store-proof-${randomUUID()}`;
const env = {
  ...process.env,
  KF_DEPLOYMENT_PROFILE: 'development',
  // Public fixture values; no identity service is started by this proof.
  KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME: 'fixture',
  KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD: 'dev-only-not-a-secret',
  KF_OBJECT_STORE_SMOKE_PROJECT: project,
};
const args = [
  'compose',
  '-p',
  project,
  '-f',
  'docker-compose.yml',
  '-f',
  'deploy/object-store/compose-smoke.yml',
];
function compose(...command) {
  return execFileSync('docker', [...args, ...command], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

try {
  compose('up', '-d', '--wait', '--wait-timeout', '120', 'seaweedfs');
  // Fails, naming the bucket, unless every bucket reads back versioning Enabled.
  compose('run', '--rm', '--no-deps', 'seaweedfs-init');
  // A signed S3 request from inside the store's network, through curl in the store's own image.
  // The public development credential is the file; the proof needs nothing else.
  const s3 = (method, target, data) =>
    compose(
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      '/bin/sh',
      'seaweedfs-init',
      '-ec',
      `printf 'user = "kf-dev-access-key:dev-only-not-a-secret"\\n' | curl -sS --fail-with-body -K - ` +
        `--aws-sigv4 aws:amz:us-east-1:s3 -X ${method} ` +
        (data === undefined ? '' : `--data-binary '${data}' `) +
        `-D /dev/stderr 'http://seaweedfs:8333/${target}'`,
    );
  for (const bucket of ['kf-artifacts', 'kf-snapshots', 'kf-checkpoints', 'kf-exports']) {
    if (!s3('GET', `${bucket}?versioning`).includes('<Status>Enabled</Status>')) {
      throw new Error(`versioning not enabled: ${bucket}`);
    }
  }
  s3('PUT', 'kf-artifacts/source-build-proof', 'kf-store-proof');
  const output = s3('GET', 'kf-artifacts/source-build-proof');
  if (output.trimEnd() !== 'kf-store-proof') throw new Error('object read-back differs');
  process.stdout.write(
    JSON.stringify({
      schema: 'kf-object-store-startup-proof-v1',
      project,
      status: 'pass',
      buckets: 4,
      versioning: 'enabled',
      objectReadBack: 'exact',
      server: 'seaweedfs 4.48',
    }) + '\n',
  );
} finally {
  // Only this random Compose project's proof containers and volumes are disposable.
  compose('down', '--volumes', '--remove-orphans');
}
