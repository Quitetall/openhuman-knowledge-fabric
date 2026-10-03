/**
 * Controlled cloud CLI for testing the real shell callers. Credentials are public plants.
 * It never exercises provider auth, HTTP, or the real CLI's verification: their suites do.
 * The real GPG ciphertext is copied on pull; requests/child environment are checked without
 * logging credential stdin. No ambient test variables are needed by the cleaned child.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Toolchain } from './fake-toolchain.js';

export const b2Configuration = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'opaque-backups',
  applicationKeyId: 'public-fixture-key-id',
  applicationKey: 'public-fixture-application-key',
};
export const b2Environment = {
  KF_B2_S3_ENDPOINT: b2Configuration.endpoint,
  KF_B2_BUCKET_NAME: b2Configuration.bucket,
  KF_B2_APPLICATION_KEY_ID: b2Configuration.applicationKeyId,
  KF_B2_APPLICATION_KEY: b2Configuration.applicationKey,
  KF_UNRELATED_SECRET: 'public-fixture-unrelated-secret',
};
export function b2Identity(digest: string, sizeBytes: number) {
  return {
    format: 'kf-offsite-object-v1',
    endpoint: b2Configuration.endpoint,
    bucket: b2Configuration.bucket,
    key: `kf-backups/v1/${digest}.tar.gpg`,
    versionId: 'recorded-version-not-latest',
    sha256: digest,
    sizeBytes,
  };
}

export function installB2CliPlant(
  tools: Toolchain,
  source: string,
  identity: ReturnType<typeof b2Identity>,
  refuse = false,
): void {
  const node = join(tools.bin, 'node');
  const original = join(tools.bin, 'non-cloud-node');
  writeFileSync(original, readFileSync(node), { mode: 0o755 });
  const program = join(tools.work, 'cloud-cli-plant.cjs');
  writeFileSync(
    program,
    `
const { readFileSync, appendFileSync, copyFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const [verb, path, digest] = process.argv.slice(2);
const packet = JSON.parse(readFileSync(0, 'utf8'));
// The fake executable's Bash shebang adds shell bookkeeping to the clean environment.
assert.ok(Object.keys(process.env).every(name => ['LANG', 'PATH', 'PWD', 'SHLVL', '_'].includes(name)));
assert.equal(packet.format, 'kf-offsite-request-v1');
assert.deepEqual(packet.configuration, ${JSON.stringify(b2Configuration)});
const identity = ${JSON.stringify(identity)};
assert.equal(digest, identity.sha256);
appendFileSync(${JSON.stringify(tools.log)}, 'b2:' + verb + ':' + (packet.copy?.versionId ?? 'new') + '\\n');
if (${refuse}) process.exit(7);
if (verb === 'publish') {
  assert.equal(packet.copy, null);
  const source = readFileSync(path);
  assert.equal(createHash('sha256').update(source).digest('hex'), digest);
  assert.equal(source.length, identity.sizeBytes);
  assert.ok([0x84,0x85,0x86,0x87,0xc1].includes(source[0]));
  process.stdout.write(JSON.stringify(identity) + '\\n');
} else {
  assert.equal(verb, 'pull');
  assert.deepEqual(packet.copy, identity);
  copyFileSync(${JSON.stringify(source)}, path);
}
`,
  );
  // Quote generated tmp paths without permitting shell expansion.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    node,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  */packages/export/dist/offsite-cli.js) shift; exec ${quote(process.execPath)} ${quote(program)} "$@" ;;
  *) exec ${quote(original)} "$@" ;;
esac
`,
    { mode: 0o755 },
  );
}
