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
  'tests/fixtures/minio-image/compose-smoke.yml',
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
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'minio');
  compose('run', '--rm', '--no-deps', 'minio-init');
  const mc = (command) =>
    compose(
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      '/bin/sh',
      'minio-init',
      '-ec',
      `mc alias set kf http://minio:9000 kf-dev-access-key dev-only-not-a-secret >/dev/null\n${command}`,
    );
  for (const bucket of ['kf-artifacts', 'kf-snapshots', 'kf-checkpoints', 'kf-exports']) {
    const result = JSON.parse(mc(`mc --json version info kf/${bucket}`));
    if (
      result.status !== 'success' ||
      result.url !== `kf/${bucket}` ||
      result.versioning?.status !== 'Enabled'
    ) {
      throw new Error(`versioning not enabled: ${bucket}`);
    }
  }
  const output = mc(
    `echo 'kf-source-build-proof' | mc pipe kf/kf-artifacts/source-build-proof >/dev/null\nmc cat kf/kf-artifacts/source-build-proof`,
  );
  if (output.trimEnd() !== 'kf-source-build-proof') throw new Error('object read-back differs');
  process.stdout.write(
    JSON.stringify({
      schema: 'kf-object-store-startup-proof-v1',
      project,
      status: 'pass',
      buckets: 4,
      versioning: 'enabled',
      objectReadBack: 'exact',
      server: 'RELEASE.2025-09-07T16-13-09Z',
      client: 'RELEASE.2025-08-13T08-35-41Z',
    }) + '\n',
  );
} finally {
  // Only this random Compose project's proof containers and volumes are disposable.
  compose('down', '--volumes', '--remove-orphans');
}
