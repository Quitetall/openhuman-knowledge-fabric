/** Runs the actual shell interface with public bytes. PID 1 admission is proved
 * separately by the selected-VM native driver, not by these ordinary-file tests.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const open: string[] = [];
afterEach(() => {
  for (const dir of open.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(name: string, contents = 'public-key-fixture') {
  const dir = mkdtempSync(join(tmpdir(), 'kf-preservation-credentials-'));
  open.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return { dir, path };
}
function sh(snippet: string, path: string, custody = '') {
  return spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; . "$1/scripts/lib/secret.sh"; . "$1/scripts/lib/preservation-secrets.sh"; ' +
        snippet,
      'fixture',
      ROOT,
      path,
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', KF_SECRET_CUSTODY: custody },
    },
  );
}

it('keeps an ordinary owner-only signing file as the existing CLI input', () => {
  const f = fixture('signing-key');
  const result = sh(
    'PRESERVATION_SIGNING_KEY_PATH="$2"; kf_prepare_preservation_signing_key || exit; printf "%s" "$PRESERVATION_SIGNING_KEY_PATH"',
    f.path,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(f.path);
  expect(readFileSync(f.path, 'utf8')).toBe('public-key-fixture');
});

it('keeps an ordinary owner-only recovery file admissible without copying it', () => {
  const f = fixture('recovery-key');
  const result = sh('kf_validate_backup_decryption_key "$2"', f.path);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
});

it('refuses group-readable signing and recovery keys without printing their bytes', () => {
  for (const operation of ['signing', 'recovery']) {
    const f = fixture(operation);
    chmodSync(f.path, 0o440);
    const result = sh(
      operation === 'signing'
        ? 'PRESERVATION_SIGNING_KEY_PATH="$2"; kf_prepare_preservation_signing_key'
        : 'kf_validate_backup_decryption_key "$2"',
      f.path,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('public-key-fixture');
  }
});

it('refuses empty, oversized, linked and symlinked private-key inputs', () => {
  for (const [purpose, limit] of [
    ['signing', 4096],
    ['recovery', 65536],
  ] as const) {
    for (const plant of ['empty', 'oversized', 'hardlink', 'symlink']) {
      const f = fixture(
        purpose,
        plant === 'empty' ? '' : plant === 'oversized' ? 'p'.repeat(limit + 1) : 'public-fixture',
      );
      let path = f.path;
      if (plant === 'hardlink') linkSync(f.path, join(f.dir, 'second'));
      if (plant === 'symlink') {
        path = join(f.dir, 'link');
        symlinkSync(f.path, path);
      }
      const result = sh(
        purpose === 'signing'
          ? 'PRESERVATION_SIGNING_KEY_PATH="$2"; kf_prepare_preservation_signing_key'
          : 'kf_validate_backup_decryption_key "$2"',
        path,
      );
      expect(result.status, `${purpose}/${plant}`).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain('public-fixture');
    }
  }
});

it('refuses a non-private recovery work directory in explicit systemd custody', () => {
  const f = fixture('recovery-key');
  chmodSync(f.dir, 0o755);
  const result = sh(
    'KF_SECRET_CUSTODY=systemd; TMPDIR="$(dirname "$2")"; KF_DRILL_WORK_ROOT="$TMPDIR"; kf_validate_drill_workspace',
    f.path,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('private tmpfs TMPDIR');
});

it('requires the systemd drill root to equal its validated private runtime directory', () => {
  const f = fixture('recovery-key');
  const result = sh(
    'KF_SECRET_CUSTODY=systemd; KF_DRILL_WORK_ROOT=/var/lib/kf-restore-drill; kf_validate_drill_workspace',
    f.path,
  );
  expect(result.status).not.toBe(0);
});

it('wires the backup and drill to the actual preservation credential interface', () => {
  const backup = readFileSync(join(ROOT, 'scripts/backup.sh'), 'utf8');
  const drill = readFileSync(join(ROOT, 'scripts/restore-drill.sh'), 'utf8');
  expect(backup).toContain('kf_prepare_preservation_signing_key');
  expect(backup.indexOf('kf_prepare_preservation_signing_key')).toBeLessThan(
    backup.indexOf('"$KF_PG_DUMP" --format=custom'),
  );
  expect(drill).toContain('kf_validate_backup_decryption_key "$KF_DRILL_DECRYPTION_KEY_FILE"');
  expect(drill.indexOf('kf_validate_drill_workspace')).toBeLessThan(
    drill.indexOf('"$KF_PSQL" "$DATABASE_URL"'),
  );
});
