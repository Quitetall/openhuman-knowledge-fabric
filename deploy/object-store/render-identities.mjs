#!/usr/bin/env node
/**
 * Render the SeaweedFS identities file (`weed server -s3.config`) for a host's own object store,
 * kf-objects (ADR 0039), at each start of the store, from the secrets the service manager hands it.
 *
 *   node render-identities.mjs <store.json> <orphan-policy.json> <out.json>
 *
 * kf-objects.service runs this as its ExecStartPre, as `kf-objects`. Each identity's secret is the
 * credential of the same name in $CREDENTIALS_DIRECTORY, which PID 1 read from that identity's own
 * secret file (`LoadCredential=kf-api:/etc/kf/api/s3-secret-access-key`, and so on). <out.json> is
 * in the unit's RuntimeDirectory, which the service manager removes when the store stops: no
 * assembled copy of the secrets stays on disk (SAS §100.54). Until 2026-10-11 provision-host.sh
 * assembled them into /etc/kf/objects/identities.json, which stayed there.
 *
 * <store.json> is NOT secret. provision-host.sh writes it (root, 0644): the artifacts bucket and
 * which identities this store serves, each with its role. A service routed at another store is not
 * in it, so its credential, if the service manager hands one over, is never rendered:
 *
 *   {"bucket": "kf-artifacts", "identities": [{"name": "kf-api", "role": "app"}, ...]}
 *
 *   admin     creates buckets and sets versioning (init-buckets.sh, kf-objects-init.service)
 *   app       reads, writes and lists the artifacts bucket (the API, the worker)
 *   storage   the storage sweep: reads and lists the bucket, and deletes ONLY where
 *             deploy/object-store/kf-storage-orphan-collection.policy.json allows, which is the
 *             evidence prefixes orphan collection works in. The policy file stays the one
 *             statement of that grant; this translates it into SeaweedFS's action form.
 *   readonly  reads and lists the bucket (the restore drill)
 *
 * SECRETS are read from the credentials directory and written only to <out.json>, created 0600;
 * never printed, never an argument. Exit 1, naming the identity and never its secret, on a missing,
 * empty or short credential: a store that starts without an identity it is meant to serve fails
 * the service that needs it later and less legibly. Exit 64 on a malformed invocation or manifest.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

function refuse(code, message) {
  process.stderr.write(`render-identities: ${message}\n`);
  process.exit(code);
}

const [manifestPath, policyPath, out, ...extra] = process.argv.slice(2);
if (manifestPath === undefined || policyPath === undefined || out === undefined || extra.length) {
  refuse(64, 'usage: render-identities.mjs <store.json> <policy.json> <out.json>');
}
const credentials = process.env['CREDENTIALS_DIRECTORY'] ?? '';
if (!isAbsolute(credentials)) {
  refuse(
    64,
    'no credentials directory: run as kf-objects.service, whose LoadCredential= lines supply the secrets',
  );
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  refuse(64, `cannot read the store manifest ${manifestPath}`);
}
const NAME = /^[a-z][a-z0-9-]{1,62}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
if (
  manifest === null ||
  typeof manifest !== 'object' ||
  Array.isArray(manifest) ||
  JSON.stringify(Object.keys(manifest).sort()) !== '["bucket","identities"]' ||
  typeof manifest.bucket !== 'string' ||
  !BUCKET.test(manifest.bucket) ||
  !Array.isArray(manifest.identities) ||
  manifest.identities.length === 0
) {
  refuse(64, `the store manifest ${manifestPath} is not {"bucket", "identities": [...]}`);
}
const bucket = manifest.bucket;

/** The policy's object resources under this bucket, as SeaweedFS `bucket/prefix/*` scopes. */
function storageDeleteScopes() {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const scopes = [];
  for (const statement of policy.Statement ?? []) {
    if (statement.Effect !== 'Allow') continue;
    const actions = [statement.Action].flat();
    if (!actions.includes('s3:DeleteObjectVersion')) continue;
    for (const resource of [statement.Resource].flat()) {
      const prefix = 'arn:aws:s3:::KF_ARTIFACTS_BUCKET/';
      if (!resource.startsWith(prefix) || !resource.endsWith('/*')) {
        throw new Error(
          `the orphan-collection policy names a resource this cannot map: ${resource}`,
        );
      }
      scopes.push(`${bucket}/${resource.slice(prefix.length)}`);
    }
  }
  if (scopes.length === 0) throw new Error('the orphan-collection policy grants no deletion');
  return scopes;
}

const ROLES = {
  admin: () => ['Admin'],
  app: () => [`Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`, `Tagging:${bucket}`],
  storage: () => [
    `Read:${bucket}`,
    `List:${bucket}`,
    ...storageDeleteScopes().map((scope) => `Write:${scope}`),
  ],
  readonly: () => [`Read:${bucket}`, `List:${bucket}`],
};

const identities = [];
const seen = new Set();
for (const entry of manifest.identities) {
  const valid =
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    JSON.stringify(Object.keys(entry).sort()) === '["name","role"]' &&
    typeof entry.name === 'string' &&
    NAME.test(entry.name) &&
    !seen.has(entry.name) &&
    typeof entry.role === 'string' &&
    Object.hasOwn(ROLES, entry.role);
  if (!valid) {
    refuse(64, `malformed identity in the store manifest: ${JSON.stringify(entry)?.slice(0, 120)}`);
  }
  const { name, role } = entry;
  seen.add(name);
  let secret = '';
  try {
    secret = readFileSync(join(credentials, name), 'utf8').trim();
  } catch {
    refuse(1, `the service manager handed over no credential for ${name}`);
  }
  if (secret.length < 16) {
    refuse(1, `the credential for ${name} is empty or short: supply that identity's secret file`);
  }
  identities.push({
    name,
    credentials: [{ accessKey: name, secretKey: secret }],
    actions: ROLES[role](),
  });
}

const text = `${JSON.stringify({ identities }, null, 2)}\n`;
// Removed first: `mode` applies only to a file this call creates.
rmSync(`${out}.tmp`, { force: true });
writeFileSync(`${out}.tmp`, text, { mode: 0o600 });
renameSync(`${out}.tmp`, out);
process.stderr.write(`render-identities: ${identities.length} identities for ${bucket}\n`);
