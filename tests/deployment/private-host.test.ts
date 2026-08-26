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

const EXAMPLE_MIGRATIONS: Record<string, string> = {
  '20260814000100_example.sql': '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n',
};

function makeRelease(migrations: Record<string, string> = EXAMPLE_MIGRATIONS): ReleaseFixture {
  const release = temporaryDirectory('kf-release-');
  const migrationDirectory = join(release, 'database', 'migrations');
  const seed = join(release, 'generated', 'sql-registry', '001-ontology-seed.sql');
  mkdirSync(migrationDirectory, { recursive: true });
  mkdirSync(dirname(seed), { recursive: true });
  for (const [name, body] of Object.entries(migrations)) {
    writeFileSync(join(migrationDirectory, name), body);
  }
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

/**
 * `state` is what the post-rollback probe reports: applied|schemas|relations|highest-version.
 * The default is a database that came all the way back, which is what a release whose
 * migrations are all reversible must produce. Pass a floor state to drive the other branch.
 */
function fakePsql(state = '0|0|0|none'): { executable: string; log: string } {
  const directory = temporaryDirectory('kf-psql-');
  const executable = join(directory, 'psql');
  const log = join(directory, 'calls.log');
  writeFileSync(
    executable,
    `#!/bin/sh
printf 'psql:%s\n' "$*" >> "$KF_TEST_PSQL_LOG"
case "$*" in
  *"current_database()"*) printf 'kf_rehearsal|empty\n' ;;
  *"public.schema_migrations"*) printf '${state}\n' ;;
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

  it('gives no identity a secret that one of its units does not need', async () => {
    // Checked against the shipped units in the repository, not only on a host at commissioning
    // time. Until 2026-08-17 five scheduled units ran as a shared `kf`, so the checkpoint
    // signing key and the preservation signing key were readable by the backup, offsite,
    // readiness and restore-drill jobs — including the one whose whole purpose is moving bytes
    // to another machine.
    //
    // The per-unit test above asserts kf-api/web/worker do not name CHECKPOINT_SIGNING_KEY, and
    // it passed the entire time, because it asks about the three units that were never the
    // problem. Sharing is allowed — kf-backup.service and kf-restore-drill.service share
    // `kf-backup` on purpose — but only between units needing exactly the same secrets, because
    // filesystem permissions cannot separate what one uid owns.
    const { readUnits } =
      await import('../../packages/operations/src/internal/commissioning/units.js');
    const units = await readUnits(join(ROOT, 'deploy', 'systemd'));
    expect(units.length, 'no units parsed, so this check proves nothing').toBeGreaterThan(5);

    const byUser = new Map<string, typeof units>();
    for (const unit of units) {
      if (unit.user === null) continue;
      byUser.set(unit.user, [...(byUser.get(unit.user) ?? []), unit]);
    }

    const surplus: string[] = [];
    for (const [user, sharing] of byUser) {
      if (sharing.length < 2) continue;
      const union = [...new Set(sharing.flatMap((unit) => unit.secretPaths))].sort();
      for (const unit of sharing) {
        const extra = union.filter((path) => !unit.secretPaths.includes(path));
        if (extra.length > 0) {
          surplus.push(`${unit.name} (as ${user}) also reaches ${extra.join(', ')}`);
        }
      }
    }
    expect(
      surplus,
      'these units share a uid with a unit that needs different secrets, so at least one can ' +
        'read a key it has no use for. Give it its own identity.',
    ).toEqual([]);

    // Non-vacuous: the property holds trivially of a fleet where nothing shares an identity,
    // so the one intentional sharing is pinned by name.
    expect(
      byUser
        .get('kf-backup')
        ?.map((unit) => unit.name)
        .sort(),
    ).toEqual(['kf-backup.service', 'kf-restore-drill.service']);
  });

  it('lets exactly one identity hold each private signing key', async () => {
    const { readUnits } =
      await import('../../packages/operations/src/internal/commissioning/units.js');
    const units = await readUnits(join(ROOT, 'deploy', 'systemd'));
    for (const key of ['checkpoint-key', 'preservation-manifest-key']) {
      const holders = [
        ...new Set(
          units
            .filter((unit) => unit.secretPaths.some((path) => path.endsWith(key)))
            .map((unit) => unit.user),
        ),
      ];
      expect(
        holders,
        `${key} is reachable by ${holders.length} identities; a signing key belongs to one`,
      ).toHaveLength(1);
    }
  });

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

  it('rehearses down to the forward-only floor only on an explicitly disposable empty target', () => {
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
    expect(receiptBody).toContain('format=kf-migration-rollback-rehearsal-v2');
    expect(receiptBody).toContain(`manifest_sha256=${release.manifestDigest}`);
    expect(receiptBody).toContain('scratch_label=test-disposable-cluster');
    // Every migration in this fixture is reversible, so the receipt must say so plainly rather
    // than claim a floor it does not have.
    expect(receiptBody).toContain('migrations_total=1');
    expect(receiptBody).toContain('migrations_reverted=1');
    expect(receiptBody).toContain('forward_only_floor=none');
    expect(receiptBody).not.toContain('database.invalid');
  });

  describe('rollback stops at the declared floor and proves where it stopped', () => {
    // Two reversible migrations above one that declares itself irreversible. Rollback must run
    // exactly two downs and leave the first migration applied.
    const WITH_FLOOR: Record<string, string> = {
      '20260814000100_first.sql': '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n',
      '20260814000200_floor.sql':
        '-- migrate:up\nselect 1;\n-- migrate:down\n-- kf:forward-only would restore open reads\n',
      '20260814000300_last.sql': '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n',
    };

    function rehearse(state: string): { code: number; output: string; receipt: string } {
      const release = makeRelease(WITH_FLOOR);
      const dbmate = fakeDbmate(release);
      const psql = fakePsql(state);
      const secret = join(temporaryDirectory('kf-rehearsal-secret-'), 'database-url');
      const receipt = join(temporaryDirectory('kf-rehearsal-receipt-'), 'receipt');
      writeFileSync(secret, 'postgresql://kf_migrator:scratch-secret@database.invalid/scratch\n', {
        mode: 0o600,
      });
      const result = runMigration(
        ['rehearse-rollback', release.release, receipt],
        release,
        dbmate,
        {
          KF_PSQL_BIN: psql.executable,
          KF_TEST_PSQL_LOG: psql.log,
          KF_REHEARSAL_DATABASE_URL_FILE: secret,
          KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION: 'dedicated-disposable-cluster',
          KF_REHEARSAL_TARGET_LABEL: 'test-disposable-cluster',
        },
      );
      return { ...result, receipt };
    }

    it('accepts a rollback that stopped exactly on the floor', () => {
      // The floor is the SECOND of three migrations, so only the third can be reverted — one
      // down, two still applied, 20260814000200 on top. Reversibility stops at the floor, it
      // does not resume below it: reverting the first would have to pass through the second.
      const result = rehearse('2|0|0|20260814000200');
      expect(result.code, result.output).toBe(0);
      const body = readFileSync(result.receipt, 'utf8');
      expect(body).toContain('migrations_total=3');
      expect(body).toContain('migrations_reverted=1');
      expect(body).toContain('forward_only_floor=20260814000200_floor.sql');
    });

    it('refuses a rollback that stopped at the right COUNT but the wrong migration', () => {
      // The count the script computes agrees with itself by construction. Only the version the
      // database actually reports can catch a floor that moved underneath it.
      const result = rehearse('2|0|0|20260814000100');
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('20260814000100');
      expect(result.output).toContain('20260814000200');
    });

    it('refuses a rollback that went past the floor', () => {
      const result = rehearse('0|0|0|none');
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('forward-only floor');
    });
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

  it('refuses a v1 receipt, whose claim of full reversibility no longer holds', () => {
    // The receipt format moved to v2 when rollback stopped promising an empty database. A v1
    // receipt reaching `apply` means either a rehearsal from before the floor existed or one
    // run against a different migration set — neither may authorise a production migration,
    // and reading it as a v2 would read "reversible to a floor" as "reversible".
    const release = makeRelease();
    const dbmate = fakeDbmate(release);
    const psql = fakePsql();
    const rehearsalSecret = join(temporaryDirectory('kf-rehearsal-secret-'), 'database-url');
    const receipt = join(temporaryDirectory('kf-rehearsal-receipt-'), 'receipt');
    writeFileSync(rehearsalSecret, 'postgresql://kf_migrator@database.invalid/scratch\n', {
      mode: 0o600,
    });
    const rehearsal = runMigration(
      ['rehearse-rollback', release.release, receipt],
      release,
      dbmate,
      {
        KF_PSQL_BIN: psql.executable,
        KF_TEST_PSQL_LOG: psql.log,
        KF_REHEARSAL_DATABASE_URL_FILE: rehearsalSecret,
        KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION: 'dedicated-disposable-cluster',
        KF_REHEARSAL_TARGET_LABEL: 'test-disposable-cluster',
      },
    );
    expect(rehearsal.code, rehearsal.output).toBe(0);

    // Every other field stays valid — digests, dbmate version, mode. Only the claim regresses,
    // so nothing but the format check can refuse this.
    writeFileSync(
      receipt,
      readFileSync(receipt, 'utf8').replace(
        'format=kf-migration-rollback-rehearsal-v2',
        'format=kf-migration-rollback-rehearsal-v1',
      ),
      { mode: 0o600 },
    );

    const productionSecret = join(temporaryDirectory('kf-production-secret-'), 'database-url');
    writeFileSync(productionSecret, 'postgresql://kf_migrator@database.invalid/kf\n', {
      mode: 0o600,
    });
    const applied = runMigration(['apply', release.release], release, fakeDbmate(release), {
      DATABASE_URL_FILE: productionSecret,
      KF_PSQL_BIN: psql.executable,
      KF_TEST_PSQL_LOG: psql.log,
      KF_ROLLBACK_REHEARSAL_RECEIPT: receipt,
      KF_MIGRATION_APPLY_CONFIRMATION: 'apply-reviewed-release',
    });

    expect(applied.code, applied.output).not.toBe(0);
    expect(applied.output).toContain('v1');
    expect(applied.output).toContain('re-run the rehearsal');
  });
});
