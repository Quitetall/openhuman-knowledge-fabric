import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATE = join(ROOT, 'scripts', 'deploy', 'migrate-release.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function walkFiles(directory: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.isFile() && entry.name !== 'SHA256SUMS') {
        result.push(relative(directory, path));
      }
    }
  };
  visit(directory);
  return result.sort();
}

function walkDirectories(directory: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      result.push(relative(directory, path));
      visit(path);
    }
  };
  visit(directory);
  return result.sort();
}

function writeReleaseManifest(release: string): string {
  writeFileSync(join(release, 'DIRECTORIES'), `${walkDirectories(release).join('\n')}\n`);
  writeFileSync(join(release, 'SYMLINKS'), '');
  const lines = walkFiles(release).map((name) => {
    const digest = createHash('sha256')
      .update(readFileSync(join(release, name)))
      .digest('hex');
    return `${digest}  ${name}`;
  });
  const manifest = join(release, 'SHA256SUMS');
  writeFileSync(manifest, `${lines.join('\n')}\n`);
  return createHash('sha256').update(readFileSync(manifest)).digest('hex');
}

interface ReleaseFixture {
  readonly release: string;
  manifestDigest: string;
}

function makeRelease(): ReleaseFixture {
  const release = temporaryDirectory('kf-release-');
  const migration = join(release, 'database', 'migrations', '20260814000100_example.sql');
  const seed = join(release, 'generated', 'sql-registry', '001-ontology-seed.sql');
  mkdirSync(dirname(migration), { recursive: true });
  mkdirSync(dirname(seed), { recursive: true });
  writeFileSync(migration, '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n');
  writeFileSync(seed, 'select 1;\n');
  return { release, manifestDigest: writeReleaseManifest(release) };
}

function fakeDbmate(release: ReleaseFixture): { executable: string; log: string } {
  const executable = join(release.release, 'tools', 'dbmate');
  const log = join(temporaryDirectory('kf-dbmate-log-'), 'calls.log');
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then echo 'dbmate version 2.35.0'; exit 0; fi\nprintf 'dbmate:%s\\n' "$*" >> "$KF_TEST_COMMAND_LOG"\n`,
  );
  chmodSync(executable, 0o755);
  release.manifestDigest = writeReleaseManifest(release.release);
  return { executable, log };
}

function fakePsql(): { executable: string; log: string } {
  const directory = temporaryDirectory('kf-psql-');
  const executable = join(directory, 'psql');
  const log = join(directory, 'calls.log');
  writeFileSync(
    executable,
    `#!/bin/sh
printf 'psql:%s\n' "$*" >> "$KF_TEST_PSQL_LOG"
case "$*" in
  *"current_database()"*) printf 'kf_rehearsal|empty\n' ;;
  *"public.schema_migrations"*) printf '0|0|0\n' ;;
esac
`,
  );
  chmodSync(executable, 0o755);
  return { executable, log };
}

function runMigration(
  args: string[],
  release: ReleaseFixture,
  dbmate: { executable: string; log: string },
  additionalEnvironment: Record<string, string> = {},
): { code: number; output: string } {
  const result = spawnSync('bash', [MIGRATE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      KF_DBMATE_BIN: dbmate.executable,
      KF_EXPECTED_DBMATE_VERSION: '2.35.0',
      KF_EXPECTED_RELEASE_MANIFEST_SHA256: release.manifestDigest,
      KF_EXPECTED_RELEASE_OWNER_UID: String(process.getuid?.() ?? statSync(release.release).uid),
      KF_MIGRATION_LOCK_FILE: join(temporaryDirectory('kf-lock-'), 'migration.lock'),
      KF_TEST_COMMAND_LOG: dbmate.log,
      ...additionalEnvironment,
    },
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('private-host service boundary', () => {
  const units = [
    ['kf-api.service', 'kf-api', '/etc/kf/api.env'],
    ['kf-web.service', 'kf-web', '/etc/kf/web.env'],
    ['kf-worker.service', 'kf-worker', '/etc/kf/worker.env'],
  ] as const;

  for (const [name, user, environmentFile] of units) {
    it(`${name} has its own identity, required environment file, and process hardening`, () => {
      const body = readFileSync(join(ROOT, 'deploy', 'systemd', name), 'utf8');
      expect(body).toContain(`User=${user}`);
      expect(body).toContain(`Group=${user}`);
      expect(body).toContain(`EnvironmentFile=${environmentFile}`);
      expect(body).toContain('NoNewPrivileges=true');
      expect(body).toContain('ProtectSystem=strict');
      expect(body).toContain('ProtectHome=true');
      expect(body).toContain('PrivateDevices=true');
      expect(body).toContain('CapabilityBoundingSet=');
      expect(body).not.toContain('CHECKPOINT_SIGNING_KEY');
    });
  }

  it('refuses empty secret placeholders before application processes start', () => {
    const api = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-api.service'), 'utf8');
    const web = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-web.service'), 'utf8');
    const worker = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-worker.service'), 'utf8');
    expect(api).toContain('ExecStartPre=/usr/bin/test -s /etc/kf/api/database-url');
    expect(api).toContain('ExecStartPre=/usr/bin/test -s /etc/kf/api/s3-secret-access-key');
    expect(web).toContain('ExecStartPre=/usr/bin/test -s /etc/kf/web/session-key');
    expect(worker).toContain('ExecStartPre=/usr/bin/test -s /etc/kf/worker/database-url');
    expect(worker).toContain('ExecStartPre=/usr/bin/test -s /etc/kf/worker/s3-secret-access-key');
  });

  it('worker host policy permits only the namespace surface needed for compiler isolation', () => {
    const worker = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-worker.service'), 'utf8');
    const environment = readFileSync(join(ROOT, 'deploy', 'systemd', 'worker.env.example'), 'utf8');
    expect(worker).toContain('StateDirectory=kf-worker');
    expect(worker).toContain('StateDirectoryMode=0700');
    expect(worker).toContain('RestrictNamespaces=user mnt pid ipc net uts cgroup');
    expect(worker).toContain('SystemCallFilter=@system-service @mount');
    expect(worker).not.toContain('RestrictNamespaces=true');
    expect(environment).toContain('LIMINAL_BWRAP_PATH=/usr/bin/bwrap');
    expect(environment).not.toContain('LIMINAL_STAGING_DIRECTORY=');
    expect(environment).toContain('LIMINAL_RUNTIME_FILE_PATHS=');
    expect(environment).toContain('S3_SECRET_ACCESS_KEY_FILE=/etc/kf/worker/s3-secret-access-key');
  });

  it('API and web listeners are fixed to loopback by their executable commands', () => {
    const api = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-api.service'), 'utf8');
    const web = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-web.service'), 'utf8');
    expect(api).toMatch(/^ExecStart=.*HOST=127\.0\.0\.1 PORT=4000 .*dist\/server\.js$/m);
    expect(web).toMatch(
      /^ExecStart=.*next\/dist\/bin\/next start --hostname 127\.0\.0\.1 --port 3000$/m,
    );
  });

  it('migration is a manual, isolated oneshot rather than a boot-time schema mutation', () => {
    const body = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-migrate.service'), 'utf8');
    expect(body).toContain('Type=oneshot');
    expect(body).toContain('User=kf-migrator');
    expect(body).toContain('Group=kf-migrator');
    expect(body).toContain('EnvironmentFile=/etc/kf/migrator.env');
    expect(body).toMatch(
      /^ExecStart=\/usr\/bin\/env DATABASE_URL_FILE=\/etc\/kf\/migrator\/database-url KF_EXPECTED_RELEASE_OWNER_UID=0 KF_MIGRATION_LOCK_FILE=\/run\/kf-migrate\/migration\.lock \/opt\/kf\/scripts\/deploy\/migrate-release\.sh apply \/opt\/kf$/m,
    );
    expect(body).not.toContain('[Install]');
  });

  it('nginx redirects cleartext and routes only to loopback application ports', () => {
    const body = readFileSync(join(ROOT, 'deploy', 'nginx', 'knowledge-fabric.conf'), 'utf8');
    expect(body).toContain('return 308 https://$host$request_uri;');
    expect(body).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
    expect(body).toContain('proxy_pass http://127.0.0.1:3000;');
    expect(body).toContain('proxy_pass http://127.0.0.1:4000;');
    expect(body).not.toMatch(/proxy_pass http:\/\/(?!127\.0\.0\.1)/);
  });

  it('carries a 10 MiB document through multipart and API transport limits', async () => {
    const nextConfig = (await import(join(ROOT, 'apps', 'web', 'next.config.mjs'))).default;
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe('11mb');

    const nginx = readFileSync(join(ROOT, 'deploy', 'nginx', 'knowledge-fabric.conf'), 'utf8');
    const webStart = nginx.indexOf('server_name fabric.example.internal;');
    const apiStart = nginx.indexOf('server_name api.fabric.example.internal;');
    expect(webStart).toBeGreaterThanOrEqual(0);
    expect(apiStart).toBeGreaterThan(webStart);

    const webServer = nginx.slice(webStart, apiStart);
    const apiServer = nginx.slice(apiStart);
    expect(webServer).toContain('client_max_body_size 11m;');
    expect(apiServer).toContain('client_max_body_size 16m;');
  });

  it('release instructions require a fresh worktree and include ignored-output dirtiness', () => {
    const body = readFileSync(join(ROOT, 'docs', 'deployment', 'private-host.md'), 'utf8');
    expect(body).toContain('worktree add --detach');
    expect(body).toContain('git status --porcelain=v1 --untracked-files=all --ignored');
  });
});

describe('release migration command', () => {
  it('has no mutating default command', () => {
    const release = makeRelease();
    const dbmate = fakeDbmate(release);
    const result = runMigration([], release, dbmate);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('usage:');
    expect(existsSync(dbmate.log)).toBe(false);
  });

  it('verifies a clean, exact release without opening a database', () => {
    const release = makeRelease();
    const dbmate = fakeDbmate(release);
    const result = runMigration(['check', release.release], release, dbmate);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('release verified');
    expect(existsSync(dbmate.log)).toBe(false);
  });

  it('refuses changed or additional release bytes before invoking migration tooling', () => {
    const changed = makeRelease();
    const changedDbmate = fakeDbmate(changed);
    writeFileSync(
      join(changed.release, 'database', 'migrations', '20260814000100_example.sql'),
      '-- changed\n',
    );
    const changedResult = runMigration(['check', changed.release], changed, changedDbmate);
    expect(changedResult.code).not.toBe(0);
    expect(changedResult.output).toMatch(/checksum|FAILED/i);
    expect(existsSync(changedDbmate.log)).toBe(false);

    const extra = makeRelease();
    const extraDbmate = fakeDbmate(extra);
    writeFileSync(join(extra.release, 'not-reviewed.txt'), 'extra\n');
    const extraResult = runMigration(['check', extra.release], extra, extraDbmate);
    expect(extraResult.code).not.toBe(0);
    expect(extraResult.output).toContain('file inventory differs');
    expect(existsSync(extraDbmate.log)).toBe(false);
  });

  it('refuses filesystem entries outside the reviewed file, directory, and symlink types', () => {
    const release = makeRelease();
    const dbmate = fakeDbmate(release);
    const fifo = join(release.release, 'unreviewed-pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    const result = runMigration(['check', release.release], release, dbmate);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('unsupported filesystem entry');
    expect(existsSync(dbmate.log)).toBe(false);
  });

  it('refuses production apply without an exact successful rollback-rehearsal receipt', () => {
    const release = makeRelease();
    const dbmate = fakeDbmate(release);
    const databaseSecret = join(temporaryDirectory('kf-migrator-secret-'), 'database-url');
    writeFileSync(databaseSecret, 'postgresql://kf_migrator@database.invalid/kf\n', {
      mode: 0o600,
    });
    const result = runMigration(['apply', release.release], release, dbmate, {
      DATABASE_URL_FILE: databaseSecret,
      KF_MIGRATION_APPLY_CONFIRMATION: 'apply-reviewed-release',
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('KF_ROLLBACK_REHEARSAL_RECEIPT');
    expect(existsSync(dbmate.log)).toBe(false);
  });

  it('rehearses every down migration only on an explicitly disposable empty target', () => {
    const release = makeRelease();
    const dbmate = fakeDbmate(release);
    const psql = fakePsql();
    const secret = join(temporaryDirectory('kf-rehearsal-secret-'), 'database-url');
    const receipt = join(temporaryDirectory('kf-rehearsal-receipt-'), 'receipt');
    writeFileSync(secret, 'postgresql://kf_migrator:scratch-secret@database.invalid/scratch\n', {
      mode: 0o600,
    });

    const result = runMigration(['rehearse-rollback', release.release, receipt], release, dbmate, {
      KF_PSQL_BIN: psql.executable,
      KF_TEST_PSQL_LOG: psql.log,
      KF_REHEARSAL_DATABASE_URL_FILE: secret,
      KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION: 'dedicated-disposable-cluster',
      KF_REHEARSAL_TARGET_LABEL: 'test-disposable-cluster',
    });

    expect(result.code, result.output).toBe(0);
    expect(readFileSync(dbmate.log, 'utf8')).toMatch(/ up\n.* down\n/s);
    const psqlCalls = readFileSync(psql.log, 'utf8');
    expect(psqlCalls).toContain(
      `-f ${join(release.release, 'generated/sql-registry/001-ontology-seed.sql')}`,
    );
    expect(psqlCalls).not.toContain('scratch-secret');
    const receiptBody = readFileSync(receipt, 'utf8');
    expect(receiptBody).toContain('format=kf-migration-rollback-rehearsal-v1');
    expect(receiptBody).toContain(`manifest_sha256=${release.manifestDigest}`);
    expect(receiptBody).toContain('scratch_label=test-disposable-cluster');
    expect(receiptBody).not.toContain('database.invalid');
  });

  it('treats relations in public as nonempty rehearsal state', () => {
    const body = readFileSync(MIGRATE, 'utf8');
    expect(body).toContain('join pg_class c on c.relnamespace = n.oid');
    expect(body).toContain("n.nspname = 'public'");
    expect(body).toContain("c.relname <> 'schema_migrations'");
  });

  it('applies and seeds only when confirmation and matching receipt are both present', () => {
    const release = makeRelease();
    const rehearsalDbmate = fakeDbmate(release);
    const rehearsalPsql = fakePsql();
    const rehearsalSecret = join(temporaryDirectory('kf-rehearsal-secret-'), 'database-url');
    const receipt = join(temporaryDirectory('kf-rehearsal-receipt-'), 'receipt');
    writeFileSync(rehearsalSecret, 'postgresql://kf_migrator@database.invalid/scratch\n', {
      mode: 0o600,
    });
    const rehearsal = runMigration(
      ['rehearse-rollback', release.release, receipt],
      release,
      rehearsalDbmate,
      {
        KF_PSQL_BIN: rehearsalPsql.executable,
        KF_TEST_PSQL_LOG: rehearsalPsql.log,
        KF_REHEARSAL_DATABASE_URL_FILE: rehearsalSecret,
        KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION: 'dedicated-disposable-cluster',
        KF_REHEARSAL_TARGET_LABEL: 'test-disposable-cluster',
      },
    );
    expect(rehearsal.code, rehearsal.output).toBe(0);

    const productionDbmate = fakeDbmate(release);
    const productionPsql = fakePsql();
    const productionSecret = join(temporaryDirectory('kf-production-secret-'), 'database-url');
    writeFileSync(
      productionSecret,
      'postgresql://kf_migrator:production-secret@database.invalid/kf\n',
      { mode: 0o600 },
    );
    const applied = runMigration(['apply', release.release], release, productionDbmate, {
      DATABASE_URL_FILE: productionSecret,
      KF_PSQL_BIN: productionPsql.executable,
      KF_TEST_PSQL_LOG: productionPsql.log,
      KF_ROLLBACK_REHEARSAL_RECEIPT: receipt,
      KF_MIGRATION_APPLY_CONFIRMATION: 'apply-reviewed-release',
    });

    expect(applied.code, applied.output).toBe(0);
    expect(readFileSync(productionDbmate.log, 'utf8')).toMatch(/ up\n.* status\n/s);
    const psqlCalls = readFileSync(productionPsql.log, 'utf8');
    expect(psqlCalls).toContain(
      `-f ${join(release.release, 'generated/sql-registry/001-ontology-seed.sql')}`,
    );
    expect(psqlCalls).not.toContain('production-secret');
  });
});
