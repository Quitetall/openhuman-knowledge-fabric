import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_MANIFEST_PATH,
  BACKUP_MANIFEST_SIGNATURE_PATH,
  backupManifestSigningBytes,
  signBackupDirectory,
  verifyBackupDirectory,
} from './backup-manifest.js';

const roots: string[] = [];

const COMPATIBILITY_PATHS = [
  'README.md',
  'dump.pgcustom',
  'export/manifest.json',
  'export/manifest.signature.json',
  'export/objects.json',
  'postgres-client-versions.txt',
  'roles.sql',
  'schema.sql',
] as const;

function writeCompatibilitySums(root: string): void {
  writeFileSync(
    join(root, 'SHA256SUMS'),
    `${COMPATIBILITY_PATHS.map((path) => {
      const digest = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
      return `${digest}  ./${path}`;
    }).join('\n')}\n`,
  );
}

function fixture(): {
  root: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
} {
  const root = mkdtempSync(join(tmpdir(), 'kf-backup-manifest-'));
  roots.push(root);
  mkdirSync(join(root, 'export'));
  writeFileSync(join(root, 'dump.pgcustom'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, 'schema.sql'), 'create schema core;\n');
  writeFileSync(join(root, 'roles.sql'), 'create role kf_app;\n');
  writeFileSync(join(root, 'README.md'), '# Backup\n');
  writeFileSync(
    join(root, 'postgres-client-versions.txt'),
    'psql (PostgreSQL) 18.1\npg_dump (PostgreSQL) 18.1\npg_dumpall (PostgreSQL) 18.1\npg_restore (PostgreSQL) 18.1\n',
  );
  writeFileSync(join(root, 'SHA256SUMS'), 'pending\n');
  writeFileSync(
    join(root, 'export', 'manifest.json'),
    `${JSON.stringify({ database_snapshot_sha256: 'a'.repeat(64) })}\n`,
  );
  writeFileSync(join(root, 'export', 'manifest.signature.json'), '{}\n');
  writeFileSync(join(root, 'export', 'objects.json'), '[]\n');
  writeCompatibilitySums(root);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { root, privateKey, publicKey };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('authenticated root backup manifests', () => {
  it('fixes outer signature domain to canonical JSON plus one LF', () => {
    const bytes = backupManifestSigningBytes({
      format_version: 'kf-backup-manifest-v1',
      database_snapshot_sha256: 'a'.repeat(64),
      files: [],
    });

    expect(bytes.toString('utf8')).toBe(
      `{"database_snapshot_sha256":"${'a'.repeat(64)}","files":[],` +
        `"format_version":"kf-backup-manifest-v1"}\n`,
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'd0759cf642787b5967fa7ad0ec36fd205d4d69659730adf314094cff3c0b3ead',
    );
  });

  it('signs every backup file and verifies against an external historical key', () => {
    const { root, privateKey, publicKey } = fixture();
    const manifest = signBackupDirectory(root, { keyId: 'preservation-2026', privateKey });

    expect(manifest.files.map((entry) => entry.path)).toEqual([
      'README.md',
      'SHA256SUMS',
      'dump.pgcustom',
      'export/manifest.json',
      'export/manifest.signature.json',
      'export/objects.json',
      'postgres-client-versions.txt',
      'roles.sql',
      'schema.sql',
    ]);
    expect(manifest.files.map((entry) => entry.path)).not.toContain(BACKUP_MANIFEST_PATH);
    expect(manifest.files.map((entry) => entry.path)).not.toContain(BACKUP_MANIFEST_SIGNATURE_PATH);
    expect(manifest.database_snapshot_sha256).toBe('a'.repeat(64));
    expect(() =>
      verifyBackupDirectory(root, new Map([['preservation-2026', publicKey]])),
    ).not.toThrow();
  });

  it('streams payloads larger than metadata limits instead of treating dumps as sidecars', () => {
    const { root, privateKey, publicKey } = fixture();
    truncateSync(join(root, 'dump.pgcustom'), 20 * 1024 * 1024);
    writeCompatibilitySums(root);
    signBackupDirectory(root, { keyId: 'preservation-2026', privateKey });

    expect(() =>
      verifyBackupDirectory(root, new Map([['preservation-2026', publicKey]])),
    ).not.toThrow();
  });

  it('stages the exact bytes it verifies so later source swaps cannot reach restore inputs', () => {
    const { root, privateKey, publicKey } = fixture();
    const staged = `${root}-staged`;
    roots.push(staged);
    signBackupDirectory(root, { keyId: 'preservation-2026', privateKey });
    verifyBackupDirectory(root, new Map([['preservation-2026', publicKey]]), {
      stageDirectory: staged,
    });

    writeFileSync(join(root, 'roles.sql'), 'create role post_verification_attacker;\n');
    expect(readFileSync(join(staged, 'roles.sql'), 'utf8')).toBe('create role kf_app;\n');
    expect(() =>
      verifyBackupDirectory(staged, new Map([['preservation-2026', publicKey]])),
    ).not.toThrow();
  });

  it('rejects changed executable bytes even when SHA256SUMS is recomputed', () => {
    const { root, privateKey, publicKey } = fixture();
    signBackupDirectory(root, { keyId: 'preservation-2026', privateKey });
    writeFileSync(join(root, 'roles.sql'), 'create role attacker superuser;\n');
    writeCompatibilitySums(root);

    expect(() => verifyBackupDirectory(root, new Map([['preservation-2026', publicKey]]))).toThrow(
      /digest|size/i,
    );
  });

  it('rejects unlisted, missing, and symbolic-link files', () => {
    const unlisted = fixture();
    signBackupDirectory(unlisted.root, {
      keyId: 'preservation-2026',
      privateKey: unlisted.privateKey,
    });
    writeFileSync(join(unlisted.root, 'surprise.sql'), 'select dangerous();\n');
    expect(() =>
      verifyBackupDirectory(unlisted.root, new Map([['preservation-2026', unlisted.publicKey]])),
    ).toThrow(/unlisted/i);

    const missing = fixture();
    signBackupDirectory(missing.root, {
      keyId: 'preservation-2026',
      privateKey: missing.privateKey,
    });
    unlinkSync(join(missing.root, 'dump.pgcustom'));
    expect(() =>
      verifyBackupDirectory(missing.root, new Map([['preservation-2026', missing.publicKey]])),
    ).toThrow(/missing/i);

    const linked = fixture();
    signBackupDirectory(linked.root, {
      keyId: 'preservation-2026',
      privateKey: linked.privateKey,
    });
    unlinkSync(join(linked.root, 'roles.sql'));
    symlinkSync('/etc/passwd', join(linked.root, 'roles.sql'));
    expect(() =>
      verifyBackupDirectory(linked.root, new Map([['preservation-2026', linked.publicKey]])),
    ).toThrow(/symbolic link/i);
  });

  it('does not trust a key nominated by the backup itself', () => {
    const trusted = generateKeyPairSync('ed25519');
    const attacker = fixture();
    signBackupDirectory(attacker.root, {
      keyId: 'attacker',
      privateKey: attacker.privateKey,
    });

    expect(() =>
      verifyBackupDirectory(attacker.root, new Map([['trusted', trusted.publicKey]])),
    ).toThrow(/unknown signing key attacker/i);
    expect(readFileSync(join(attacker.root, BACKUP_MANIFEST_PATH), 'utf8')).toContain(
      'kf-backup-manifest-v1',
    );
  });

  it('rejects a noncanonical base64 spelling of the same signature bytes', () => {
    const { root, privateKey, publicKey } = fixture();
    signBackupDirectory(root, { keyId: 'preservation-2026', privateKey });
    const path = join(root, BACKUP_MANIFEST_SIGNATURE_PATH);
    const sidecar = JSON.parse(readFileSync(path, 'utf8')) as { signature_base64: string };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const position = sidecar.signature_base64.length - 3;
    const canonicalIndex = alphabet.indexOf(sidecar.signature_base64[position]!);
    sidecar.signature_base64 =
      sidecar.signature_base64.slice(0, position) +
      alphabet[canonicalIndex + 1] +
      sidecar.signature_base64.slice(position + 1);
    writeFileSync(path, `${JSON.stringify(sidecar)}\n`);

    expect(() => verifyBackupDirectory(root, new Map([['preservation-2026', publicKey]]))).toThrow(
      /non-canonical|invalid/i,
    );
  });
});
