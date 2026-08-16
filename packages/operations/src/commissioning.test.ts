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
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
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
  await Promise.all([
    mkdir(shipped),
    mkdir(systemd),
    mkdir(secrets),
    mkdir(evidence),
  ]);

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
  it('satisfies every check', async () => {
    const { inputs } = await commissionedHost();
    const report = await assessCommissioning(inputs);
    const unsatisfied = report.checks.filter((entry) => entry.status !== 'satisfied');
    expect(unsatisfied.map((entry) => `${entry.id}: ${entry.detail}`)).toEqual([]);
    expect(report.commissioned).toBe(true);
    expect(formatCommissioning(report)).toContain('COMMISSIONED');
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
      CHECKPOINT_UNIT.replaceAll('SECRET_DIR', secrets).replace('User=kf-checkpoint', 'User=kf-api'),
    );
    // Also update the shipped copy, so provenance passes and identity separation is the only
    // thing that can fail — otherwise this test would pass for the wrong reason.
    await writeFile(
      join(inputs.shippedUnitDirectory!, 'kf-checkpoint.service'),
      CHECKPOINT_UNIT.replaceAll('SECRET_DIR', secrets).replace('User=kf-checkpoint', 'User=kf-api'),
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
});

describe('the shipped units', () => {
  it('are exactly what unit_provenance compares against', async () => {
    // Guards the check against the repository, not the other way round: if a unit stops
    // declaring OnFailure or the two identities converge, this fails in CI rather than on a
    // host at commissioning time.
    const { readUnits } = await import('./internal/commissioning/units.js');
    const shipped = await readUnits('deploy/systemd');
    expect(shipped.length).toBeGreaterThan(0);
    for (const unit of shipped) {
      expect(unit.onFailure, `${unit.name} declares no OnFailure=`).not.toBeNull();
    }
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
