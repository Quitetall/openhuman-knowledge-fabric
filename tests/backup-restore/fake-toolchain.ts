/**
 * A fake PostgreSQL client and export CLI for running the SHIPPED backup scripts without a
 * database.
 *
 * The drill test (`drill.test.ts`) runs these scripts against real containers and is the
 * end-to-end proof. It is also slow and needs Docker, so the properties added on top of it —
 * what gets encrypted, what gets pruned, which copy a drill restores, what the ledger is told —
 * are pinned here against the real scripts with only their external programs replaced. Every
 * SQL statement and every export-CLI call is logged, so a test can assert both what the script
 * did and what it did NOT do.
 *
 * gpg, tar, rsync, sha256sum and df are the real programs: encryption is the property under
 * test, and faking it would test the fake.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

export interface Toolchain {
  readonly work: string;
  readonly bin: string;
  readonly log: string;
  /** Files whose contents the fake psql prints for a matching query. */
  readonly responses: string;
  readonly env: Record<string, string>;
  cleanup(): void;
  sqlLog(): string;
}

const FAKE_PSQL = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then echo 'psql (PostgreSQL) 18.0'; exit 0; fi
log="$KF_FAKE_LOG"
responses="$KF_FAKE_RESPONSES"
command_sql=""
previous=""
for argument in "$@"; do
  if [ "$previous" = -c ]; then command_sql="$argument"; fi
  previous="$argument"
done
printf 'psql-args:%s\\n' "$*" >> "$log"
if [ -n "$command_sql" ]; then
  printf 'psql-c:%s\\n' "$command_sql" >> "$log"
  exit 0
fi
# The backup's snapshot coordinator is a coproc that speaks line by line.
if [[ " $* " == *" --tuples-only "* ]]; then
  while IFS= read -r line; do
    printf 'coproc:%s\\n' "$line" >> "$log"
    case "$line" in
      'select pg_export_snapshot();') echo '00000003-0000001B-1' ;;
      '\\q') exit 0 ;;
    esac
  done
  exit 0
fi
sql="$(cat)"
printf 'sql:%s\\n' "$(printf '%s' "$sql" | tr '\\n' ' ')" >> "$log"
respond() { if [ -f "$responses/$1" ]; then cat "$responses/$1"; fi; }
case "$sql" in
  *'select r.location'*) respond prunable ;;
  *'pg_database_size'*) respond estimate ;;
  *'select id, manifest_digest from ops.backup_run'*) respond run-row ;;
  *'from ops.physical_failure_domain_evidence'*'count(*)'*|*'count(*) from ops.physical_failure_domain_evidence'*) respond domain-current ;;
  *'drill-selection'*) respond drill-row ;;
  *'select id from ops.backup_run where location'*) respond run-id ;;
  *) ;;
esac
`;

const FAKE_NODE = `#!/usr/bin/env bash
set -euo pipefail
# Anything that is not the export CLI is real JavaScript and runs on the real Node.
case "\${1:-}" in
  */packages/export/dist/cli.js) ;;
  *) exec "$KF_REAL_NODE" "$@" ;;
esac
shift
printf 'export-cli:%s\\n' "$*" >> "$KF_FAKE_LOG"
command="$1"; shift
case "$command" in
  write)
    mkdir -p "$1"
    printf '{"rows":[]}\\n' > "$1/manifest.json"
    ;;
  verify) test -f "$1/manifest.json" ;;
  sign-backup)
    printf '{"database_snapshot_sha256":"%s"}\\n' \\
      0000000000000000000000000000000000000000000000000000000000000000 > "$1/backup.manifest.json"
    printf 'valid-signature\\n' > "$1/backup.manifest.signature.json"
    ;;
  verify-backup)
    dir="$1"; shift
    grep -qx 'valid-signature' "$dir/backup.manifest.signature.json" || {
      echo "backup manifest signature corrupt at $dir" >&2; exit 3; }
    stage=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --stage ]; then stage="$2"; shift; fi
      shift
    done
    if [ -n "$stage" ]; then cp -a "$dir" "$stage"; fi
    ;;
  *) echo "unexpected export-cli command $command" >&2; exit 2 ;;
esac
`;

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export function toolchain(prefix: string): Toolchain {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(work, 'bin');
  const responses = join(work, 'responses');
  const log = join(work, 'calls.log');
  mkdirSync(bin);
  mkdirSync(responses);
  writeFileSync(log, '');
  executable(join(bin, 'psql'), FAKE_PSQL);
  executable(join(bin, 'node'), FAKE_NODE);
  for (const tool of ['pg_dump', 'pg_dumpall', 'pg_restore']) {
    executable(
      join(bin, tool),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then echo '${tool} (PostgreSQL) 18.0'; exit 0; fi
printf '${tool}:%s\\n' "$*" >> "$KF_FAKE_LOG"
for argument in "$@"; do
  case "$argument" in --file=*) printf '${tool} output\\n' > "\${argument#--file=}" ;; esac
done
`,
    );
  }
  const trust = join(work, 'trust');
  mkdirSync(trust);
  const signingKey = join(work, 'preservation-key');
  writeFileSync(signingKey, 'not-a-real-key\n', { mode: 0o600 });
  return {
    work,
    bin,
    log,
    responses,
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      KF_REAL_NODE: process.execPath,
      KF_FAKE_LOG: log,
      KF_FAKE_RESPONSES: responses,
      KF_POSTGRES_CLIENT_DIR: bin,
      DATABASE_URL: 'postgres://kf@localhost/kf',
      PRESERVATION_SIGNING_KEY_PATH: signingKey,
      PRESERVATION_SIGNING_KEY_ID: 'test-preservation-key',
      PRESERVATION_TRUST_STORE_DIR: trust,
      NODE_ENV: 'test',
    },
    cleanup: () => rmSync(work, { recursive: true, force: true }),
    sqlLog: () => readFileSync(log, 'utf8'),
  };
}

export interface RecipientKeys {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly keyId: string;
}

/** A real OpenPGP keypair, generated into a throwaway home. Takes well under a second. */
export function recipientKeys(directory: string): RecipientKeys {
  const home = join(directory, 'gnupg-generate');
  mkdirSync(home, { mode: 0o700 });
  const gpg = (args: string[]): string =>
    execFileSync('gpg', ['--batch', '--no-tty', '--homedir', home, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  gpg(['--passphrase', '', '--quick-gen-key', 'kf backup test <kf@example.invalid>', 'ed25519']);
  const fingerprint = /^fpr:+([0-9A-F]{40}):/m.exec(gpg(['--with-colons', '--list-keys']))![1]!;
  gpg(['--passphrase', '', '--quick-add-key', fingerprint, 'cv25519', 'encr', 'never']);
  const publicKey = join(directory, 'recipient.asc');
  const secretKey = join(directory, 'recipient-secret.asc');
  writeFileSync(publicKey, gpg(['--armor', '--export']));
  writeFileSync(
    secretKey,
    gpg(['--pinentry-mode', 'loopback', '--passphrase', '', '--armor', '--export-secret-keys']),
    { mode: 0o600 },
  );
  const keyId = /^sub:[^:]*:[^:]*:[^:]*:([0-9A-F]{16}):/m.exec(
    gpg(['--with-colons', '--list-keys']),
  )![1]!;
  rmSync(home, { recursive: true, force: true });
  return { publicKey, secretKey, keyId };
}

/** Decrypt with the recipient's secret key and list what the archive holds. */
export function decryptAndList(ciphertext: string, keys: RecipientKeys, work: string): string[] {
  const home = mkdtempSync(join(work, 'gnupg-decrypt-'));
  chmodSync(home, 0o700);
  execFileSync('gpg', ['--batch', '--no-tty', '--homedir', home, '--import', keys.secretKey], {
    stdio: 'ignore',
  });
  const plaintext = join(work, 'decrypted.tar');
  execFileSync('gpg', [
    '--batch',
    '--no-tty',
    '--quiet',
    '--homedir',
    home,
    '--output',
    plaintext,
    '--decrypt',
    ciphertext,
  ]);
  return execFileSync('tar', ['--list', '--file', plaintext], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .sort();
}

export function runScript(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): { code: number; output: string } {
  const result = spawnSync('bash', [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
