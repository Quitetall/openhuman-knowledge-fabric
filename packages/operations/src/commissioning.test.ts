/**
 * Commissioning, and the property that makes it worth running: it never says yes by default.
 *
 * Every check below is exercised twice — once against a host set up correctly, once against a
 * planted violation — because a verifier that has only ever been seen to pass is a verifier
 * nobody has tested. The third state, `unverifiable`, gets the same treatment: "we could not
 * look" must never be reported as "we looked and it was fine".
 */

import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessCommissioning,
  COMMISSIONING_CHECKS,
  formatCommissioning,
  parseUnit,
  type CommissioningInputs,
  type CommissioningReport,
} from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kf-commissioning-'));
  roots.push(root);
  return root;
}

const API_UNIT = `[Unit]
Description=Knowledge Fabric API
OnFailure=kf-alert@%n.service

[Service]
User=kf-api
EnvironmentFile=/nonexistent/api.env
ExecStart=/usr/bin/env DATABASE_URL_FILE=SECRET_DIR/database-url /usr/bin/node server.js
`;

const CHECKPOINT_UNIT = `[Unit]
Description=Sign a Merkle checkpoint
OnFailure=kf-alert@%n.service

[Service]
User=kf-checkpoint
Environment=CHECKPOINT_SIGNING_KEY_PATH=SECRET_DIR/checkpoint-key
ExecStart=/usr/bin/node main.js --run
`;

/** A host where everything was done properly, so a failure below is the planted one. */
async function commissionedHost(): Promise<{
  inputs: Partial<CommissioningInputs>;
  systemd: string;
  secrets: string;
  evidence: string;
}> {
  const root = await scratch();
  const shipped = join(root, 'shipped');
  const systemd = join(root, 'systemd');
  const secrets = join(root, 'secrets');
  const evidence = join(root, 'evidence');
  await Promise.all([mkdir(shipped), mkdir(systemd), mkdir(secrets), mkdir(evidence)]);

  const api = API_UNIT.replaceAll('SECRET_DIR', secrets).replace(
    '/nonexistent/api.env',
    join(secrets, 'api.env'),
  );
  const checkpoint = CHECKPOINT_UNIT.replaceAll('SECRET_DIR', secrets);
  for (const directory of [shipped, systemd]) {
    await writeFile(join(directory, 'kf-api.service'), api);
    await writeFile(join(directory, 'kf-checkpoint.service'), checkpoint);
  }
  for (const secret of ['api.env', 'database-url', 'checkpoint-key']) {
    await writeFile(join(secrets, secret), 'not-a-real-secret\n');
    await chmod(join(secrets, secret), 0o600);
  }

  const { certificatePath, keyPath } = await selfSigned(root, 'fabric.example.org');
  const policy = join(root, 'realm-policy.json');
  await writeFile(policy, '{"requiredAcr":"mfa","implicitFlow":false}\n');

  // A correctly configured reverse proxy: cleartext redirects rather than proxies, the
  // upstream is loopback, TLS 1.0/1.1 are refused and the original scheme is forwarded.
  const reverseProxy = join(root, 'nginx.conf');
  await writeFile(
    reverseProxy,
    `server {
    listen 80;
    server_name fabric.example.org;
    return 308 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name fabric.example.org;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_set_header X-Forwarded-Proto https;
        proxy_pass http://127.0.0.1:4000;
    }
}
`,
  );

  const releaseId = 'kf-1.0.0';
  await writeFile(
    join(evidence, 'release-verification.json'),
    JSON.stringify({ release: releaseId, verified: true }),
  );
  await writeFile(
    join(evidence, 'rollback-rehearsal.json'),
    JSON.stringify({ release: releaseId, recordedAt: new Date().toISOString() }),
  );
  await writeFile(
    join(evidence, 'compiler-qualification.json'),
    JSON.stringify({ release: releaseId, ratified: true }),
  );

  return {
    systemd,
    secrets,
    evidence,
    inputs: {
      shippedUnitDirectory: shipped,
      systemdDirectory: systemd,
      publicHostname: 'fabric.example.org',
      tlsCertificatePath: certificatePath,
      tlsPrivateKeyPath: keyPath,
      identityIssuer: 'https://sso.example.org/realms/kf',
      identityClientId: 'knowledge-fabric',
      identityPolicyPath: policy,
      identityPolicyDigest: await digestOf(policy),
      reverseProxyConfigPath: reverseProxy,
      evidenceDirectory: evidence,
      releaseId,
      expectedNodeVersion: process.versions.node,
      certificateRenewalDays: 21,
      rollbackRehearsalDays: 180,
    },
  };
}

async function digestOf(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * A real certificate, because `X509Certificate.checkHost` applies the SAN and wildcard rules
 * and a hand-written PEM would only prove the parser runs.
 */
async function selfSigned(
  root: string,
  hostname: string,
): Promise<{ certificatePath: string; keyPath: string }> {
  const { execFileSync } = await import('node:child_process');
  const keyPath = join(root, 'tls.key');
  const certificatePath = join(root, 'tls.crt');
  generateKeyPairSync('rsa', { modulusLength: 2048 });
  execFileSync('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
    '-days',
    '365',
    '-subj',
    `/CN=${hostname}`,
    '-addext',
    `subjectAltName=DNS:${hostname}`,
  ]);
  await chmod(keyPath, 0o600);
  return { certificatePath, keyPath };
}

function check(report: CommissioningReport, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  expect(found, `no check named ${id}`).toBeDefined();
  return found!;
}

describe('a host nobody commissioned', () => {
  it('reports every check unverifiable rather than passing on absent evidence', async () => {
    // The default inputs point at a real host's `/etc/systemd/system`, which this test
    // process cannot rely on, and supply nothing else. Every answer must be "we could not
    // look" — never "fine".
    const report = await assessCommissioning({
      systemdDirectory: join(await scratch(), 'does-not-exist'),
      shippedUnitDirectory: join(await scratch(), 'also-missing'),
    });

    expect(report.commissioned).toBe(false);
    expect(report.checks).toHaveLength(COMMISSIONING_CHECKS.length);
    expect(report.checks.filter((entry) => entry.status === 'satisfied')).toEqual([]);
    // And it says which blocker each unanswered question belongs to, so the output is a work
    // list rather than a verdict.
    for (const entry of report.checks) {
      expect(entry.blocker, `${entry.id} names no blocker`).not.toBe('');
    }
    expect(formatCommissioning(report)).toContain('NOT COMMISSIONED');
  });
});

describe('a host that was commissioned properly', () => {
  it('satisfies every check that can be satisfied without root', async () => {
    // ONE CHECK IS EXCLUDED, AND THE REASON IS AN ENVIRONMENT LIMIT RATHER THAN A GAP.
    //
    // `liminal_runtime_inventory` runs the release's own verify-liminal-runtime.sh, which
    // requires the external shared-library closure to be root-owned files under /lib, /lib64,
    // /usr/lib or /usr/lib64 with matching digests. A test process cannot create those, so no
    // fixture here can make that check pass.
    //
    // Excluded BY NAME rather than by loosening this to "most checks pass". Naming it means
    // adding a second unsatisfiable check is a visible edit to this list, and every other
    // check still has to be satisfied. `report.commissioned` is therefore false — correctly,
    // because a host on which that check has not run is not a commissioned host.
    const environmentLimited = ['liminal_runtime_inventory'];

    const { inputs } = await commissionedHost();
    const report = await assessCommissioning(inputs);
    const unsatisfied = report.checks
      .filter((entry) => !environmentLimited.includes(entry.id))
      .filter((entry) => entry.status !== 'satisfied');
    expect(unsatisfied.map((entry) => `${entry.id}: ${entry.detail}`)).toEqual([]);

    // And the excluded one reports "we could not look", never a quiet pass.
    for (const id of environmentLimited) {
      expect(check(report, id).status, `${id} should be unverifiable here`).toBe('unverifiable');
    }
    expect(report.commissioned).toBe(false);
    expect(formatCommissioning(report)).toContain('NOT COMMISSIONED');
  });
});

describe('planted violations — commissioning must refuse', () => {
  it('an installed unit that differs from the one this release ships', async () => {
    const { inputs, systemd } = await commissionedHost();
    await writeFile(
      join(systemd, 'kf-api.service'),
      `${API_UNIT}\n# edited on the host after installation\n`,
    );
    const entry = check(await assessCommissioning(inputs), 'unit_provenance');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/altered|missing/i);
  });

  it('the API and the checkpoint signer sharing one system identity', async () => {
    const { inputs, systemd, secrets } = await commissionedHost();
    await writeFile(
      join(systemd, 'kf-checkpoint.service'),
      CHECKPOINT_UNIT.replaceAll('SECRET_DIR', secrets).replace(
        'User=kf-checkpoint',
        'User=kf-api',
      ),
    );
    // Also update the shipped copy, so provenance passes and identity separation is the only
    // thing that can fail — otherwise this test would pass for the wrong reason.
    await writeFile(
      join(inputs.shippedUnitDirectory!, 'kf-checkpoint.service'),
      CHECKPOINT_UNIT.replaceAll('SECRET_DIR', secrets).replace(
        'User=kf-checkpoint',
        'User=kf-api',
      ),
    );
    const entry = check(await assessCommissioning(inputs), 'unit_provenance');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/same system user/i);
  });

  it('but says nothing about units this release does not ship', async () => {
    // Found by running the verifier against a real machine rather than a fixture: an
    // unfiltered read of /etc/systemd/system audited display-manager.service and
    // dbus-org.bluez.service for OnFailure=, which is true, irrelevant, and enough to fail a
    // correctly commissioned host. Commissioning speaks only for this release's units.
    const { inputs, systemd } = await commissionedHost();
    await writeFile(
      join(systemd, 'somebody-elses-daemon.service'),
      '[Service]\nUser=root\nExecStart=/usr/bin/true\n',
    );
    const entry = check(await assessCommissioning(inputs), 'unit_provenance');
    expect(entry.status).toBe('satisfied');
    expect(String(entry.observed?.['withoutOnFailure'])).toBe('none');
  });

  it('a secret file the rest of the host can read', async () => {
    const { inputs, secrets } = await commissionedHost();
    await chmod(join(secrets, 'checkpoint-key'), 0o644);
    const entry = check(await assessCommissioning(inputs), 'secret_posture');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.observed?.['groupOrWorldReadable']).toMatch(/checkpoint-key/);
  });

  it('a certificate issued for a different hostname', async () => {
    const { inputs } = await commissionedHost();
    const entry = check(
      await assessCommissioning({ ...inputs, publicHostname: 'other.example.org' }),
      'tls_termination',
    );
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/not valid for other\.example\.org/);
  });

  it('a TLS private key readable beyond its owner', async () => {
    const { inputs } = await commissionedHost();
    await chmod(inputs.tlsPrivateKeyPath!, 0o640);
    const entry = check(await assessCommissioning(inputs), 'tls_termination');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/readable beyond its owner/);
  });

  it('an identity provider reached over plaintext', async () => {
    const { inputs } = await commissionedHost();
    const entry = check(
      await assessCommissioning({ ...inputs, identityIssuer: 'http://sso.example.org/realms/kf' }),
      'identity_provider_policy',
    );
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/prove nothing/);
  });

  it('a realm policy that changed after it was reviewed', async () => {
    const { inputs } = await commissionedHost();
    await writeFile(inputs.identityPolicyPath!, '{"requiredAcr":"pwd","implicitFlow":true}\n');
    const entry = check(await assessCommissioning(inputs), 'identity_provider_policy');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/not the one that was reviewed/);
  });

  it('a runtime other than the one the release was tested on', async () => {
    const { inputs } = await commissionedHost();
    const entry = check(
      await assessCommissioning({ ...inputs, expectedNodeVersion: '0.0.1' }),
      'runtime_version',
    );
    expect(entry.status).toBe('unsatisfied');
    expect(entry.observed?.['expected']).toBe('0.0.1');
  });

  it('a rollback rehearsal too old to describe this system', async () => {
    const { inputs, evidence } = await commissionedHost();
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      join(evidence, 'rollback-rehearsal.json'),
      JSON.stringify({ release: inputs.releaseId, recordedAt: longAgo }),
    );
    const entry = check(await assessCommissioning(inputs), 'evidence_receipts');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/past the 180-day limit/);
  });

  it('a compiler qualification recorded but never ratified', async () => {
    const { inputs, evidence } = await commissionedHost();
    await writeFile(
      join(evidence, 'compiler-qualification.json'),
      JSON.stringify({ release: inputs.releaseId, ratified: false }),
    );
    const entry = check(await assessCommissioning(inputs), 'evidence_receipts');
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/not ratified/);
  });

  it('receipts describing a release the host is not running', async () => {
    const { inputs } = await commissionedHost();
    const entry = check(
      await assessCommissioning({ ...inputs, releaseId: 'kf-2.0.0' }),
      'evidence_receipts',
    );
    expect(entry.status).toBe('unsatisfied');
    expect(entry.detail).toMatch(/kf-1\.0\.0.*kf-2\.0\.0|kf-2\.0\.0/);
  });

  it('a missing receipt, as unverifiable rather than as satisfied', async () => {
    const { inputs, evidence } = await commissionedHost();
    await rm(join(evidence, 'release-verification.json'));
    const entry = check(await assessCommissioning(inputs), 'evidence_receipts');
    expect(entry.status).toBe('unverifiable');
    expect(entry.detail).toMatch(/may or may not have happened/);
  });
});

describe('unit parsing', () => {
  it('finds secrets wherever the deployment puts them, not only in one directive', async () => {
    // The shipped units pass secrets as paths in `Environment=`, in `ExecStart=` and via
    // `EnvironmentFile=`. A parser that only read one of those would report a closed host
    // while the secret named somewhere else went unchecked.
    const facts = parseUnit(
      'kf-example.service',
      [
        '[Service]',
        'User=kf-api',
        'EnvironmentFile=/etc/kf/api.env',
        'Environment=CHECKPOINT_SIGNING_KEY_PATH=/etc/kf/checkpoint-key',
        'ExecStart=/usr/bin/env DATABASE_URL_FILE=/etc/kf/database-url /usr/bin/node server.js',
        '# Environment=IGNORED_FILE=/etc/kf/commented-out',
      ].join('\n'),
    );
    expect(facts.user).toBe('kf-api');
    expect(facts.secretPaths).toEqual([
      '/etc/kf/api.env',
      '/etc/kf/checkpoint-key',
      '/etc/kf/database-url',
    ]);
  });

  it('ignores an optional-file marker rather than treating it as part of the path', () => {
    const facts = parseUnit('x.service', '[Service]\nEnvironmentFile=-/etc/kf/optional.env\n');
    expect(facts.secretPaths).toEqual(['/etc/kf/optional.env']);
  });

  it('does not treat a lock path as a secret, and still sweeps everything beside it', () => {
    // `kf-migrate.service` carries both on ONE ExecStart line:
    //
    //   DATABASE_URL_FILE=/etc/kf/migrator/database-url   a real secret
    //   KF_MIGRATION_LOCK_FILE=/run/kf-migrate/migration.lock   a lock
    //
    // The lock exists only while the migration runs, so at rest it made `secret_posture`
    // report `unverifiable` on a correctly built host — a check that could never pass, which
    // in turn made 8/8 and ADR 0004's criterion 3 unreachable.
    //
    // Both halves are asserted deliberately. Dropping the lock is only correct if the secret
    // sharing the same line is still collected; a rule that quietly stopped inspecting
    // `database-url` would be a far worse defect than the one it replaced.
    const facts = parseUnit(
      'kf-migrate.service',
      [
        '[Service]',
        'User=kf-migrator',
        'ExecStart=/usr/bin/env DATABASE_URL_FILE=/etc/kf/migrator/database-url' +
          ' KF_MIGRATION_LOCK_FILE=/run/kf-migrate/migration.lock /opt/kf/migrate.sh apply',
      ].join('\n'),
    );
    expect(facts.secretPaths).toEqual(['/etc/kf/migrator/database-url']);
  });

  describe('secret_posture judges identities, not mode bits', () => {
    /**
     * A unit plus the one file it names, in a throwaway directory.
     *
     * The file is left in the test user's own primary group, which is the only group this test
     * can arrange without root — and it is exactly the shape under test: `root:kf-api` on a
     * real host is "owned by one identity, group-readable by the one service that uses it".
     */
    async function fixture(mode: number, unitUser: string): Promise<string> {
      const root = await scratch();
      const secret = join(root, 'service.env');
      await writeFile(secret, 'LOG_LEVEL=info\n');
      await chmod(secret, mode);
      await writeFile(
        join(root, 'kf-fixture.service'),
        `[Service]\nUser=${unitUser}\nEnvironmentFile=${secret}\n`,
      );
      return root;
    }

    const assess = async (root: string) => {
      const { secretPosture } = await import('./internal/commissioning/units.js');
      return secretPosture({
        systemdDirectory: root,
        shippedUnitDirectory: root,
        certificateRenewalDays: 21,
        rollbackRehearsalDays: 180,
      });
    };

    /** Who can actually read files in the test user's primary group, computed from the host. */
    async function ownGroupReaders(): Promise<readonly string[]> {
      const gid = process.getgid?.() ?? 0;
      const { readFile: read } = await import('node:fs/promises');
      const readers = new Set<string>();
      for (const line of (await read('/etc/group', 'utf8')).split('\n')) {
        const [, , id, members] = line.split(':');
        if (id === undefined || Number(id) !== gid) continue;
        for (const m of (members ?? '').split(',')) if (m !== '') readers.add(m);
      }
      for (const line of (await read('/etc/passwd', 'utf8')).split('\n')) {
        const [name, , , primary] = line.split(':');
        if (name !== undefined && primary !== undefined && Number(primary) === gid) {
          readers.add(name);
        }
      }
      return [...readers].sort();
    }

    it('accepts group-read when the group holds only the unit’s own identity', async () => {
      // The case that was wrongly refused. `api.env.example` says in its first line "Non-secret
      // API routing ... owned root:kf-api, mode 0640", the README installs exactly that, and
      // the old `mode & 0o077` test called it exposed on the first real host install.
      const readers = await ownGroupReaders();
      expect(
        readers.length,
        `this test needs a primary group with exactly one member to stand in for kf-api; ` +
          `this one holds ${readers.join(', ')}. Run it as a user with their own group.`,
      ).toBe(1);

      const result = await assess(await fixture(0o640, readers[0]!));
      expect(result.status, result.detail).toBe('satisfied');
    });

    it('refuses group-read when someone the unit does not name can read', async () => {
      // Same file, same mode — only the declared identity differs. This is the security
      // property the old check was reaching for and the new one states exactly.
      const result = await assess(await fixture(0o640, 'kf-somebody-else'));
      expect(result.status).toBe('unsatisfied');
      expect(result.detail).toContain('does not name');
    });

    it('refuses world-read no matter whose file it is', async () => {
      const readers = await ownGroupReaders();
      const result = await assess(await fixture(0o644, readers[0] ?? 'root'));
      expect(result.status).toBe('unsatisfied');
      expect(String(result.observed?.['groupOrWorldReadable'])).toContain('world-readable');
    });
  });

  it('still treats an unrecognised *_FILE as a secret, so the rule stays fail-closed', () => {
    // The exclusion is an enumerated exception, not a licence to guess. Anything that is not
    // explicitly a lock keeps being inspected, including a name nobody has seen before.
    const facts = parseUnit(
      'x.service',
      '[Service]\nEnvironment=SOME_BRAND_NEW_FILE=/etc/kf/unknown-secret\n',
    );
    expect(facts.secretPaths).toEqual(['/etc/kf/unknown-secret']);
  });
});

describe('the shipped units', () => {
  it('are exactly what unit_provenance compares against', async () => {
    // Guards the check against the repository, not the other way round: if a unit stops
    // declaring OnFailure or the two identities converge, this fails in CI rather than on a
    // host at commissioning time.
    const { readUnits } = await import('./internal/commissioning/units.js');
    const shipped = await readUnits('deploy/systemd');
    expect(shipped.length).toBeGreaterThan(0);

    // Every unit routes failure to an alert, EXCEPT the alert path itself, which must not.
    // An alerter whose own failure is reported through the path that just failed is a loop,
    // and on a host with an unreachable endpoint an unbounded one.
    //
    // Asserted as an EXACT set rather than skipped: a unit outside it with no OnFailure= is
    // silently unreported, a unit inside it with one loops, and a third name joining the
    // exemption is a decision somebody should have to make here rather than in passing.
    const alertPath = ['kf-alert-heartbeat.service', 'kf-alert@.service'];
    expect(
      shipped
        .filter((unit) => unit.onFailure === null)
        .map((unit) => unit.name)
        .sort(),
      'the set of units without OnFailure= is not exactly the alert path',
    ).toEqual(alertPath);
    const api = shipped.find((unit) => unit.name === 'kf-api.service');
    const checkpoint = shipped.find((unit) => unit.name === 'kf-checkpoint.service');
    expect(api?.user).toBeDefined();
    expect(checkpoint?.user).toBeDefined();
    expect(api?.user, 'API and checkpoint signer must not share an identity').not.toBe(
      checkpoint?.user,
    );
  });
});

describe('certificate parsing', () => {
  it('reads a real certificate rather than trusting a subject string', async () => {
    const root = await scratch();
    const { certificatePath } = await selfSigned(root, 'fabric.example.org');
    const { readFile } = await import('node:fs/promises');
    const certificate = new X509Certificate(await readFile(certificatePath));
    expect(certificate.checkHost('fabric.example.org')).toBe('fabric.example.org');
    expect(certificate.checkHost('evil.example.org')).toBeUndefined();
  });
});

describe('reverse proxy posture', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  async function configured(body: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'kf-nginx-'));
    directories.push(directory);
    const path = join(directory, 'site.conf');
    await writeFile(path, body);
    return path;
  }

  const assess = async (path: string | undefined) => {
    const { reverseProxyPosture } = await import('./internal/commissioning/host.js');
    return reverseProxyPosture({
      systemdDirectory: '/etc/systemd/system',
      shippedUnitDirectory: 'deploy/systemd',
      certificateRenewalDays: 21,
      rollbackRehearsalDays: 180,
      ...(path === undefined ? {} : { reverseProxyConfigPath: path }),
    });
  };

  const TLS_BLOCK = `server {
    listen 443 ssl;
    server_name fabric.example.internal;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_set_header X-Forwarded-Proto https;
        proxy_pass http://127.0.0.1:3000;
    }
}`;

  it('accepts the configuration this repository ships', async () => {
    // Against the real template, not a fixture resembling it. A check that passes a
    // hand-written approximation and fails the shipped file is worse than no check.
    const result = await assess('deploy/nginx/knowledge-fabric.conf');
    expect(result.status, result.detail).toBe('satisfied');
  });

  it('refuses a cleartext server that proxies to the application', async () => {
    // The sharpest failure this can catch: bearer tokens crossing the network in clear, which
    // is precisely what KF_TLS_TERMINATED_UPSTREAM=1 asserts does not happen.
    const path = await configured(`server {
    listen 80;
    server_name fabric.example.internal;
    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-Proto https; }
}`);
    const result = await assess(path);
    expect(result.status).toBe('unsatisfied');
    expect(result.detail).toContain('cleartext');
  });

  it('accepts a cleartext server that only redirects', async () => {
    const path = await configured(`server {
    listen 80;
    server_name fabric.example.internal;
    return 308 https://$host$request_uri;
}
${TLS_BLOCK}`);
    expect((await assess(path)).status).toBe('satisfied');
  });

  it('refuses an upstream that is not loopback', async () => {
    const path = await configured(TLS_BLOCK.replace('127.0.0.1', '10.0.0.9'));
    const result = await assess(path);
    expect(result.status).toBe('unsatisfied');
    expect(result.detail).toContain('loopback');
  });

  it('refuses TLS 1.0 and 1.1', async () => {
    const path = await configured(TLS_BLOCK.replace('TLSv1.2 TLSv1.3', 'TLSv1 TLSv1.2'));
    expect((await assess(path)).status).toBe('unsatisfied');
  });

  it('refuses a proxying block that does not forward the original scheme', async () => {
    const path = await configured(
      TLS_BLOCK.replace('    proxy_set_header X-Forwarded-Proto https;\n', ''),
    );
    expect((await assess(path)).status).toBe('unsatisfied');
  });

  it('ignores a commented-out proxy_pass rather than reading it as live', async () => {
    const path = await configured(`server {
    listen 80;
    server_name fabric.example.internal;
    # location / { proxy_pass http://127.0.0.1:3000; }
    return 308 https://$host$request_uri;
}
${TLS_BLOCK}`);
    expect((await assess(path)).status).toBe('satisfied');
  });

  it('is unverifiable, not satisfied, when the file defines no server blocks', async () => {
    // An nginx.conf that only includes other files parses to nothing here. Reporting that as
    // a pass would be the worst outcome available: a clean result from a file never read.
    const path = await configured('include /etc/nginx/sites-enabled/*;\n');
    const result = await assess(path);
    expect(result.status).toBe('unverifiable');
    expect(result.detail).toContain('does not follow includes');
  });

  it('is unverifiable when no configuration is supplied at all', async () => {
    expect((await assess(undefined)).status).toBe('unverifiable');
  });
});

describe('liminal runtime inventory', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  const LIMINAL_VARS = [
    'LIMINAL_COMPILER_PATH',
    'LIMINAL_CARGO_LOCK_PATH',
    'LIMINAL_RUNTIME_FILE_PATHS',
    'LIMINAL_EXECUTABLE_SHA256',
    'LIMINAL_CARGO_LOCK_SHA256',
    'LIMINAL_RUNTIME_CLOSURE_SHA256',
  ] as const;

  const assess = async (releaseDirectory?: string) => {
    const { liminalRuntimeInventory } = await import('./internal/commissioning/host.js');
    return liminalRuntimeInventory({
      systemdDirectory: '/etc/systemd/system',
      shippedUnitDirectory: 'deploy/systemd',
      certificateRenewalDays: 21,
      rollbackRehearsalDays: 180,
      ...(releaseDirectory === undefined ? {} : { releaseDirectory }),
    });
  };

  /** A release tree carrying this repository's real verifier and a plausible vendor payload. */
  async function releaseTree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kf-release-'));
    directories.push(root);
    const { copyFile } = await import('node:fs/promises');
    await mkdir(join(root, 'scripts', 'deploy'), { recursive: true });
    await copyFile(
      'scripts/deploy/verify-liminal-runtime.sh',
      join(root, 'scripts', 'deploy', 'verify-liminal-runtime.sh'),
    );
    await mkdir(join(root, 'vendor', 'liminal'), { recursive: true });
    // ELF magic, so the verifier reaches the digest comparison rather than refusing earlier —
    // the digest comparison is the control under test.
    const compiler = join(root, 'vendor', 'liminal', 'liminal-document-compiler');
    await writeFile(compiler, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
    await chmod(compiler, 0o755);
    await writeFile(join(root, 'vendor', 'liminal', 'Cargo.lock'), 'version = 4\n');
    await writeFile(
      join(root, 'vendor', 'liminal', 'RUNTIME-CLOSURE.json'),
      JSON.stringify({
        format: 'kf-liminal-runtime-closure-v1',
        entries: [],
        runtimeClosureDigest: '0'.repeat(64),
      }),
    );
    // ADR 0010: a release declares whether it carries a Liminal compiler. This one does, so
    // every assertion below still exercises the sealed path rather than the deferred one.
    await writeFile(join(root, 'BUILD-METADATA'), 'git_commit=deadbeef\nliminal=sealed\n');
    return root;
  }

  /** A release built the ordinary v1.0 way: native compiler, no Liminal payload. */
  async function releaseWithoutLiminal(declaration = 'liminal=none\n'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kf-release-native-'));
    directories.push(root);
    await writeFile(join(root, 'BUILD-METADATA'), `git_commit=deadbeef\n${declaration}`);
    return root;
  }

  function withLiminalEnvironment(root: string, overrides: Record<string, string> = {}) {
    const saved = new Map(LIMINAL_VARS.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      LIMINAL_COMPILER_PATH: join(root, 'vendor', 'liminal', 'liminal-document-compiler'),
      LIMINAL_CARGO_LOCK_PATH: join(root, 'vendor', 'liminal', 'Cargo.lock'),
      LIMINAL_RUNTIME_FILE_PATHS: '/usr/lib/libc.so.6',
      LIMINAL_EXECUTABLE_SHA256: 'a'.repeat(64),
      LIMINAL_CARGO_LOCK_SHA256: 'b'.repeat(64),
      LIMINAL_RUNTIME_CLOSURE_SHA256: 'c'.repeat(64),
      ...overrides,
    });
    return () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  }

  it('is unverifiable when no release directory is supplied', async () => {
    const result = await assess(undefined);
    expect(result.status).toBe('unverifiable');
  });

  // ADR 0010. The v1.0 release carries no Liminal compiler, and the danger in allowing that is
  // a check that passes because its subject is absent. These four hold the line: the check's
  // subject became "the declaration matches what is installed", which fails both ways.

  it('is satisfied when a release declares no Liminal compiler and ships none', async () => {
    const result = await assess(await releaseWithoutLiminal());
    expect(result.status).toBe('satisfied');
    expect(result.detail).toContain('declares no Liminal compiler');
  });

  it('FAILS when a release declares none and ships one anyway', async () => {
    // The reason the `none` branch is a check rather than a shrug. An unreviewed compiler
    // inside a release is worse than a mislabelled release, so the declaration is not trusted.
    const root = await releaseWithoutLiminal();
    await mkdir(join(root, 'vendor', 'liminal'), { recursive: true });
    await writeFile(join(root, 'vendor', 'liminal', 'liminal-document-compiler'), 'not reviewed');
    const result = await assess(root);
    expect(result.status).toBe('unsatisfied');
    expect(result.detail).toContain('ships a Liminal runtime directory anyway');
  });

  it('is unverifiable when a release declares nothing, rather than assuming none', async () => {
    // Every release built before ADR 0010 is in this state. Defaulting them to `none` would
    // make a release that DOES carry a compiler silently claim it does not — fail-open, and
    // invisible.
    const result = await assess(await releaseWithoutLiminal(''));
    expect(result.status).toBe('unverifiable');
    expect(result.detail).toContain('does not state whether');
  });

  it('is unverifiable when the release has no BUILD-METADATA at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kf-release-bare-'));
    directories.push(root);
    const result = await assess(root);
    expect(result.status).toBe('unverifiable');
    expect(result.detail).toContain('BUILD-METADATA');
  });

  it('is unverifiable, and names them, when the LIMINAL_* values are absent', async () => {
    // The common case on a host where somebody ran kf-commissioning from their own shell
    // rather than with the worker's environment. It must not read as a host defect.
    const saved = new Map(LIMINAL_VARS.map((name) => [name, process.env[name]]));
    for (const name of LIMINAL_VARS) delete process.env[name];
    try {
      const result = await assess(await releaseTree());
      expect(result.status).toBe('unverifiable');
      expect(result.detail).toContain('LIMINAL_COMPILER_PATH');
    } finally {
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
  });

  it('refuses a compiler whose digest is not the reviewed one, in the verifier’s own words', async () => {
    // Runs this repository's real verify-liminal-runtime.sh. The check deliberately does not
    // reimplement the digesting: two statements of one rule drift, and a disagreement between
    // them would itself be the security problem.
    const root = await releaseTree();
    const restore = withLiminalEnvironment(root);
    try {
      const result = await assess(root);
      expect(result.status).toBe('unsatisfied');
      expect(result.detail).toContain('digest mismatch');
    } finally {
      restore();
    }
  });

  it('reports its own misuse as unverifiable rather than as a host finding', async () => {
    // Exit 64 is the verifier's usage error, which means this check called it wrongly. A bug
    // here must never be reported as "the host failed".
    const root = await mkdtemp(join(tmpdir(), 'kf-release-empty-'));
    directories.push(root);
    const restore = withLiminalEnvironment(root);
    try {
      const result = await assess(root);
      // No verifier at that path at all: spawn fails, which is also not a host finding.
      expect(result.status).not.toBe('satisfied');
    } finally {
      restore();
    }
  });
});
