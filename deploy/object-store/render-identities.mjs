#!/usr/bin/env node
/**
 * Render the SeaweedFS identities file (`weed server -s3.config`) for a host's own object store,
 * kf-objects (ADR 0039), from the secret files the identities' services already hold.
 *
 *   node render-identities.mjs <out.json> <orphan-policy.json> <artifacts-bucket>
 *
 * The identities come from KF_OBJECTS_IDENTITIES, one per line, `name|secret-file|role`:
 *
 *   admin     creates buckets and sets versioning (init-buckets.sh, kf-objects-init.service)
 *   app       reads, writes and lists the artifacts bucket (the API, the worker)
 *   storage   the storage sweep: reads and lists the bucket, and deletes ONLY where
 *             deploy/object-store/kf-storage-orphan-collection.policy.json allows, which is the
 *             evidence prefixes orphan collection works in. The policy file stays the one
 *             statement of that grant; this translates it into SeaweedFS's action form.
 *   readonly  reads and lists the bucket (the restore drill)
 *
 * SECRETS are read here from their files and written only to <out.json>, created 0600; never
 * printed, never an argument. Prints `changed` or `unchanged`, so the caller restarts the store
 * only when the file did change. Exit 1 on any unreadable or empty secret: an identity without
 * its secret is a store nobody can use, and must not be written half.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const [out, policyPath, bucket] = process.argv.slice(2);
if (out === undefined || policyPath === undefined || bucket === undefined) {
  process.stderr.write('usage: render-identities.mjs <out.json> <policy.json> <bucket>\n');
  process.exit(64);
}
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
  process.stderr.write(`render-identities: ${JSON.stringify(bucket)} is not a bucket name\n`);
  process.exit(64);
}

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
for (const line of (process.env['KF_OBJECTS_IDENTITIES'] ?? '').split('\n')) {
  if (line.trim() === '') continue;
  const [name, secretFile, role] = line.split('|');
  if (name === undefined || secretFile === undefined || role === undefined || !(role in ROLES)) {
    process.stderr.write(`render-identities: malformed identity line for ${name ?? '?'}\n`);
    process.exit(64);
  }
  let secret;
  try {
    secret = readFileSync(secretFile, 'utf8').trim();
  } catch {
    process.stderr.write(`render-identities: cannot read the secret for ${name} (${secretFile})\n`);
    process.exit(1);
  }
  if (secret.length < 16) {
    process.stderr.write(
      `render-identities: the secret for ${name} (${secretFile}) is empty or short\n`,
    );
    process.exit(1);
  }
  identities.push({
    name,
    credentials: [{ accessKey: name, secretKey: secret }],
    actions: ROLES[role](),
  });
}
if (identities.length === 0) {
  process.stderr.write('render-identities: KF_OBJECTS_IDENTITIES names no identity\n');
  process.exit(64);
}

const text = `${JSON.stringify({ identities }, null, 2)}\n`;
let current;
try {
  current = readFileSync(out, 'utf8');
} catch {
  current = undefined;
}
if (current === text) {
  process.stdout.write('unchanged\n');
} else {
  // Removed first: `mode` applies only to a file this call creates.
  rmSync(`${out}.tmp`, { force: true });
  writeFileSync(`${out}.tmp`, text, { mode: 0o600 });
  renameSync(`${out}.tmp`, out);
  process.stdout.write('changed\n');
}
