/**
 * A restore verifies with nothing but what the release ships and what the drill identity holds.
 *
 * Two frictions removed on 2026-09-23, both pinned here against the real `restore-verify.sh`:
 *
 *   - The object-store verifier. A host used to have to write, install and digest-pin its own
 *     program; a host that had not recorded every drill `partial`. With no override named, the
 *     release's own verifier (`apps/kf-storage/dist/verify-object-store.js`) now reads the store.
 *   - The preservation signing key. The re-export that is compared file by file with the backup
 *     used to be signed with the host's long-lived private key, so the drill had to run as the
 *     identity that SIGNS backups. It is now signed with a key made for the run.
 *
 * The export CLI, PostgreSQL client and the release's verifier/checkpoint programs are fakes in
 * a scratch release tree; `restore-verify.sh` and `object-store-proof.mjs` are the real bytes.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, runScript, toolchain, type Toolchain } from './fake-toolchain.js';

const open: Toolchain[] = [];
afterEach(() => {
  for (const tools of open.splice(0)) tools.cleanup();
});

const OBJECT = Buffer.from('evidence bytes\n');
const DIGEST = createHash('sha256').update(OBJECT).digest('hex');

function release() {
  const tools = toolchain('kf-restore-defaults-');
  open.push(tools);
  const tree = join(tools.work, 'release');
  mkdirSync(join(tree, 'scripts', 'lib'), { recursive: true });
  const script = join(tree, 'scripts', 'restore-verify.sh');
  copyFileSync(join(ROOT, 'scripts', 'restore-verify.sh'), script);
  for (const lib of ['secret.sh', 'preservation-secrets.sh', 'object-store-proof.mjs']) {
    copyFileSync(join(ROOT, 'scripts', 'lib', lib), join(tree, 'scripts', 'lib', lib));
  }

  // The backup: an export holding one stored object, and the re-export the fake CLI "writes"
  // from the restored database — the same files, as a faithful restore would produce.
  const exportFiles = {
    'manifest.json': '{"rows":[]}\n',
    'artifact-versions.json': `${JSON.stringify([
      {
        id: '1',
        sha256: DIGEST,
        size_bytes: OBJECT.length,
        storage_uri: 'ingest/org/object',
        storage_version: 'v1',
      },
    ])}\n`,
  };
  const backup = join(tools.work, 'backup');
  const reexportSource = join(tools.work, 'reexport-source');
  for (const directory of [join(backup, 'export'), reexportSource]) {
    mkdirSync(directory, { recursive: true });
    for (const [name, body] of Object.entries(exportFiles)) {
      writeFileSync(join(directory, name), body);
    }
  }
  writeFileSync(join(backup, 'backup.manifest.signature.json'), 'valid-signature\n');
  writeFileSync(join(backup, 'roles.sql'), '');
  writeFileSync(join(backup, 'dump.pgcustom'), '');
  writeFileSync(
    join(backup, 'backup.manifest.json'),
    `{"database_snapshot_sha256":"${'0'.repeat(64)}"}\n`,
  );

  // An export CLI that answers every command but `write`, which it logs and satisfies from
  // the re-export fixture, and a PostgreSQL client that reports an empty target with roles.
  const bin = join(tools.work, 'bin-first');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  */packages/export/dist/cli.js)
    if [ "\${2:-}" = write ]; then
      printf 'export-write:%s\\n' "$*" >> "$KF_FAKE_LOG"
      printf 'export-database-input:%s\\n' "$(cat "\${DATABASE_URL_FILE:-/dev/null}")" >> "$KF_FAKE_LOG"
      mkdir -p "$3"; cp -a "${reexportSource}/." "$3/"
      exit 0
    fi
    exec "${join(tools.bin, 'node')}" "$@" ;;
  *) exec "$KF_REAL_NODE" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'psql'),
    `#!/usr/bin/env bash
if [ "\${1:-}" = --version ]; then echo 'psql (PostgreSQL) 18.0'; exit 0; fi
case "$*" in
  *"schema_name = 'core'"*) echo 0 ;;
  *"string_agg(r"*) echo '' ;;
  *) exec "${join(tools.bin, 'psql')}" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  for (const tool of ['pg_dump', 'pg_dumpall', 'pg_restore']) {
    symlinkSync(join(tools.bin, tool), join(bin, tool));
  }
  writeFileSync(join(tools.responses, 'run-id'), '11111111-1111-4111-8111-111111111111\n');

  // The release's own programs. The verifier stands in for the store: it answers with what the
  // store "holds", and records how it was invoked. The checkpoint verifier reports clean.
  const verifierLog = join(tools.work, 'verifier.log');
  const verifier = join(tree, 'apps', 'kf-storage', 'dist', 'verify-object-store.js');
  mkdirSync(join(verifier, '..'), { recursive: true });
  writeFileSync(
    verifier,
    `const fs = require('node:fs');
const [request, proof] = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(verifierLog)}, JSON.stringify({
  argv: process.argv.slice(2).length,
  secretFile: process.env.S3_SECRET_ACCESS_KEY_FILE ?? null,
  bucket: process.env.S3_BUCKET_ARTIFACTS ?? null,
}));
const out = fs.readFileSync(request, 'utf8').split('\\n').filter(Boolean).map((line) =>
  JSON.stringify({ ...JSON.parse(line), sha256: process.env.KF_TEST_STORE_SHA256, size_bytes: ${OBJECT.length} }) + '\\n');
fs.writeFileSync(proof, out.join(''));
`,
  );
  writeFileSync(join(tree, 'apps', 'kf-storage', 'package.json'), '{"type":"commonjs"}\n');
  const checkpoint = join(tree, 'apps', 'checkpoint', 'dist', 'main.js');
  mkdirSync(join(checkpoint, '..'), { recursive: true });
  writeFileSync(
    checkpoint,
    "const fs = require('node:fs'); fs.appendFileSync(process.env.KF_FAKE_LOG, 'checkpoint-database-input:' + fs.readFileSync(process.env.DATABASE_URL_FILE ?? '/dev/null', 'utf8').trim() + '\\n'); console.log('checkpoints verified');\n",
  );
  writeFileSync(join(tree, 'apps', 'checkpoint', 'package.json'), '{"type":"commonjs"}\n');
  const checkpointKeys = join(tools.work, 'checkpoint-public-keys');
  mkdirSync(checkpointKeys);
  writeFileSync(join(checkpointKeys, 'ckpt.pub'), 'public\n');

  const secretFile = join(tools.work, 's3-secret');
  writeFileSync(secretFile, 'drill-reader-secret\n', { mode: 0o600 });
  const url = (name: string, value: string): string => {
    const path = join(tools.work, name);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    return path;
  };
  return {
    tools,
    script,
    backup,
    verifierLog,
    args: [
      backup,
      url('target-url', 'postgresql:///kf_drill?host=/tmp/x&port=55432&user=kf_drill'),
      url('ledger-url', 'postgres://kf@localhost/kf'),
    ],
    env: {
      ...tools.env,
      PATH: `${bin}:${tools.env['PATH']!}`,
      KF_POSTGRES_CLIENT_DIR: bin,
      // Nothing about the preservation PRIVATE key: the drill identity does not hold it.
      PRESERVATION_SIGNING_KEY_PATH: '',
      PRESERVATION_SIGNING_KEY_ID: '',
      CHECKPOINT_PUBLIC_KEY_DIR: checkpointKeys,
      KF_OBJECT_STORE_VERIFY_PROGRAM: '',
      KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256: '',
      KF_OBJECT_STORE_PROOF_REF: '',
      S3_ENDPOINT: 'http://127.0.0.1:9',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'drill-reader',
      S3_BUCKET_ARTIFACTS: 'kf-artifacts',
      S3_SECRET_ACCESS_KEY_FILE: secretFile,
      KF_TEST_STORE_SHA256: DIGEST,
    },
  };
}

describe('restore-verify.sh with only what the release ships', () => {
  it('binds export and checkpoint children to the restore target instead of an inherited production file', () => {
    const r = release();
    const inherited = join(r.tools.work, 'production-url');
    writeFileSync(inherited, 'postgres://not-the-target@localhost/production\n', { mode: 0o600 });
    const result = runScript(r.script, r.args, { ...r.env, DATABASE_URL_FILE: inherited });
    expect(result.code, result.output).toBe(0);
    const target = readFileSync(r.args[1]!, 'utf8').trim();
    expect(r.tools.sqlLog()).toContain(`export-database-input:${target}`);
    expect(r.tools.sqlLog()).toContain(`checkpoint-database-input:${target}`);
    expect(r.tools.sqlLog()).not.toContain('database-input:postgres://not-the-target');
  });
  it('verifies the object store with the in-release verifier and records a verified drill', () => {
    const r = release();
    const result = runScript(r.script, r.args, r.env);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('object store: 1 of 1 stored object(s) measured and matched');
    expect(result.output).toContain('restore fully verified');

    const invoked = JSON.parse(readFileSync(r.verifierLog, 'utf8')) as Record<string, unknown>;
    // Two arguments — request and proof — and the credential as a FILE path from the unit.
    expect(invoked).toEqual({
      argv: 2,
      secretFile: r.env.S3_SECRET_ACCESS_KEY_FILE,
      bucket: 'kf-artifacts',
    });
    const log = r.tools.sqlLog();
    expect(log).toContain('outcome=verified');
    expect(log).toContain('object_ref=kf-builtin-verifier:kf-artifacts');
  });

  it('signs the throwaway re-export with a run-local key, never the preservation key', () => {
    const r = release();
    const result = runScript(r.script, r.args, r.env);
    expect(result.code, result.output).toBe(0);
    const write = r.tools
      .sqlLog()
      .split('\n')
      .find((line) => line.startsWith('export-write:'));
    expect(write).toBeDefined();
    expect(write).toMatch(
      /--signing-key \S+\/reexport-key\/key\.pem --key-id restore-verify-reexport/,
    );
  });

  it('refuses to call a measurement verified when the store holds other bytes', () => {
    const r = release();
    const result = runScript(r.script, r.args, { ...r.env, KF_TEST_STORE_SHA256: 'f'.repeat(64) });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('OBJECT STORE NOT VERIFIED');
    expect(r.tools.sqlLog()).toContain('outcome=partial');
  });

  it('says what to configure when there is no store to verify against', () => {
    const r = release();
    const result = runScript(r.script, r.args, { ...r.env, S3_ENDPOINT: '' });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('/etc/kf/drill.env');
    expect(result.output).toContain('RESTORE PARTIAL');
  });
});
