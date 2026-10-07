/**
 * One command provisions a host, and `--check` says exactly what it still lacks.
 *
 * The hardening of 2026-09-23 added a dozen host secrets and files, each a hand-typed line in
 * deploy/systemd/README.md. `scripts/deploy/provision-host.sh` makes every one a machine can,
 * and lists the rest with the path each goes in. These run the real script in a fake root
 * (`KF_PROVISION_ROOT`) with the account and ownership commands faked — every fake logs its
 * argv, so a secret reaching argv would be caught here — and real `gpg`, `node` and `install`.
 */

import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'deploy', 'provision-host.sh');
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Host {
  readonly root: string;
  readonly log: string;
  readonly bin: string;
  run(args?: string[], env?: Record<string, string>): { code: number; output: string };
  path(hostPath: string): string;
  calls(): string;
}

/**
 * A fake root and fake account tools. `getent` answers from files the fake `useradd`,
 * `groupadd` and `usermod` edit, mapping every account to the test's own uid and gid — so the
 * script's numeric ownership checks compare real `stat` output against real ids.
 */
function host(): Host {
  const work = mkdtempSync(join(tmpdir(), 'kf-provision-'));
  directories.push(work);
  const root = join(work, 'root');
  const bin = join(work, 'bin');
  const log = join(work, 'calls.log');
  mkdirSync(root);
  mkdirSync(bin);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  writeFileSync(join(work, 'passwd'), `root:x:${uid}:${gid}::/root:/bin/bash\n`);
  writeFileSync(join(work, 'group'), `root:x:${gid}:\n`);
  writeFileSync(log, '');
  const tool = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`,
      { mode: 0o755 },
    );
  tool('getent', `db="${work}/$1"; grep -E "^$2:" "$db" || exit 2`);
  tool(
    'useradd',
    `name="\${@: -1}"; echo "$name:x:${uid}:${gid}::/nonexistent:/usr/sbin/nologin" >> "${work}/passwd"; echo "$name:x:${gid}:" >> "${work}/group"`,
  );
  tool('groupadd', `name="\${@: -1}"; echo "$name:x:${gid}:" >> "${work}/group"`);
  tool(
    'usermod',
    `group="$2"; user="$3"; sed -i -E "/^$group:/{s/:\\$/:$user/;t;s/$/,$user/}" "${work}/group"`,
  );
  tool('chown', ':');
  tool('systemctl', ':');
  // Seals by copying, with a marker, so the test can see WHAT was sealed without a TPM.
  tool('systemd-creds', `in="\${@: -2:1}"; out="\${@: -1}"; { echo SEALED; cat "$in"; } > "$out"`);
  tool('runuser', `shift 3; exec "$@"`);
  return {
    root,
    log,
    bin,
    path: (hostPath) => join(root, hostPath),
    calls: () => readFileSync(log, 'utf8'),
    run(args = [], env = {}) {
      const r = spawnSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          HOME: work,
          KF_PROVISION_ROOT: root,
          KF_PROVISION_NODE: process.execPath,
          // Never the network: the pinned SeaweedFS tarball is "fetched" from a path that does
          // not exist unless a test supplies one.
          KF_OBJECTS_RELEASE_URL: `file://${work}/no-seaweedfs-here.tar.gz`,
          ...env,
        },
      });
      return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
    },
  };
}

const mode = (path: string): string => (statSync(path).mode & 0o7777).toString(8);

/** Every file under a directory, recursively, as root-relative paths. */
function tree(directory: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      out.push(path.slice(directory.length));
      if (entry.isDirectory()) visit(path);
    }
  };
  if (existsSync(directory)) visit(directory);
  return out.sort();
}

const GENERATED = [
  '/etc/kf/migrator/rehearsal-receipt-key',
  '/etc/kf/web/session-key',
  '/etc/kf/api/readiness-token',
  '/etc/kf/api/master-record-link-secret',
  '/etc/kf/checkpoint/checkpoint-key',
];

describe('provision-host.sh --check on a bare host', () => {
  it('changes nothing and reports what provisioning would create', () => {
    const h = host();
    const result = h.run(['--check']);
    expect(result.code).toBe(1);
    expect(tree(h.root)).toEqual([]);
    expect(result.output).toContain('user kf-drill');
    expect(result.output).toContain('directory /etc/kf/drill');
    expect(h.calls()).not.toMatch(/^(useradd|groupadd|usermod|chown) /m);
  });
});

describe('provision-host.sh', () => {
  it('creates identities, directories, env files and every machine-generatable secret', async () => {
    const h = host();
    const result = h.run();
    expect(result.code, result.output).toBe(0);

    for (const user of [
      'kf-api',
      'kf-migrator',
      'kf-checkpoint',
      'kf-audit-verify',
      'kf-drill',
      'kf-retrieval-key',
      'kf-embedding',
      'kf-retrieval',
    ]) {
      expect(h.calls()).toContain(
        `useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin ${user}`,
      );
    }
    expect(h.calls()).toContain('usermod -aG kf-archive kf-backup');
    expect(h.calls()).toContain('usermod -aG kf-archive kf-offsite');
    expect(h.calls()).toContain('usermod -aG kf-retrieval kf-api');
    expect(h.calls()).toContain('usermod -aG kf-retrieval kf-worker');
    for (const name of [
      'kf-retrieval-key.socket',
      'kf-retrieval-key@.service',
      'kf-embedding.service',
      'lamu-retrieval.service',
      'kf-retrieval-credentials.path',
    ]) {
      expect(readFileSync(h.path(`/etc/systemd/system/${name}`), 'utf8')).toBe(
        readFileSync(join(ROOT, 'deploy/systemd', name), 'utf8'),
      );
    }
    expect(mode(h.path('/srv/kf-backups'))).toBe('2750');
    expect(mode(h.path('/etc/kf/drill'))).toBe('750');
    expect(mode(h.path('/etc/kf/credstore.encrypted'))).toBe('700');

    // Generated: owner-only, non-empty, chowned to the one identity that reads each.
    for (const secret of GENERATED) {
      expect(mode(h.path(secret)), secret).toBe('600');
      expect(statSync(h.path(secret)).size, secret).toBeGreaterThanOrEqual(32);
    }
    expect(h.calls()).toContain(
      'chown kf-migrator:kf-migrator ' + h.path('/etc/kf/migrator/rehearsal-receipt-key'),
    );
    expect(h.calls()).toContain(
      'chown kf-checkpoint:kf-checkpoint ' + h.path('/etc/kf/checkpoint/checkpoint-key'),
    );
    // The web session key is exactly what the web process accepts: canonical base64 of 32 bytes.
    const session = readFileSync(h.path('/etc/kf/web/session-key'), 'utf8');
    expect(Buffer.from(session, 'base64')).toHaveLength(32);
    expect(Buffer.from(session, 'base64').toString('base64')).toBe(session);

    // The checkpoint key id names the key, its public half is published under that id, and the
    // env file is completed with it.
    const env = readFileSync(h.path('/etc/kf/checkpoint.env'), 'utf8');
    const id = /^CHECKPOINT_SIGNING_KEY_ID=(ckpt-[0-9a-f]{16})$/m.exec(env)?.[1];
    expect(id, env).toBeDefined();
    const published = readFileSync(h.path(`/etc/kf/checkpoint-public-keys/${id}.pub`), 'utf8');
    const derived = createPublicKey(
      createPrivateKey(readFileSync(h.path('/etc/kf/checkpoint/checkpoint-key'))),
    ).export({ format: 'pem', type: 'spki' });
    expect(published).toBe(derived);
    // And the signer itself accepts the pair: `--run` refuses a key its trust directory does not
    // publish under the configured id, so this is the check that matters.
    const { loadSigningKey } = await import('../../apps/checkpoint/src/sign/keys.js');
    const { assertSigningKeyTrusted, signingKeyId } =
      await import('../../apps/checkpoint/src/config.js');
    const production = {
      NODE_ENV: 'production',
      CHECKPOINT_SIGNING_KEY_ID: id,
      CHECKPOINT_PUBLIC_KEY_DIR: h.path('/etc/kf/checkpoint-public-keys'),
    };
    expect(() =>
      assertSigningKeyTrusted(
        loadSigningKey(
          signingKeyId(production),
          readFileSync(h.path('/etc/kf/checkpoint/checkpoint-key'), 'utf8'),
        ),
        production,
      ),
    ).not.toThrow();

    const api = readFileSync(h.path('/etc/kf/api.env'), 'utf8');
    expect(api).toMatch(/^KF_READINESS_TOKEN_FILE=\/etc\/kf\/api\/readiness-token$/m);
    expect(api).toMatch(
      /^KF_MASTER_RECORD_LINK_SECRET_FILE=\/etc\/kf\/api\/master-record-link-secret$/m,
    );
    expect(mode(h.path('/etc/kf/api.env'))).toBe('640');
    expect(mode(h.path('/etc/kf/storage/storage.env'))).toBe('600');

    // Every unit this release ships is installed byte for byte.
    for (const unit of readdirSync(join(ROOT, 'deploy', 'systemd')).filter((n) =>
      /\.(service|timer)$/.test(n),
    )) {
      expect(readFileSync(h.path(`/etc/systemd/system/${unit}`), 'utf8')).toBe(
        readFileSync(join(ROOT, 'deploy', 'systemd', unit), 'utf8'),
      );
    }
  });

  it('never puts a secret in its output or in any command line', () => {
    const h = host();
    const result = h.run();
    expect(result.code, result.output).toBe(0);
    const everything = `${result.output}\n${h.calls()}`;
    for (const secret of GENERATED) {
      const value = readFileSync(h.path(secret));
      // Raw keys may not be text; check both the bytes' text and a base64 rendering.
      for (const needle of [value.toString('utf8').trim(), value.toString('base64')]) {
        if (needle.length >= 16) expect(everything, secret).not.toContain(needle);
      }
    }
  });

  it('is safe to re-run: nothing that exists is regenerated, and no account is re-created', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    const before = Object.fromEntries(GENERATED.map((s) => [s, readFileSync(h.path(s))]));
    const env = readFileSync(h.path('/etc/kf/checkpoint.env'), 'utf8');
    writeFileSync(h.log, '');
    const again = h.run();
    expect(again.code, again.output).toBe(0);
    for (const secret of GENERATED) {
      expect(readFileSync(h.path(secret)).equals(before[secret]!), secret).toBe(true);
    }
    expect(readFileSync(h.path('/etc/kf/checkpoint.env'), 'utf8')).toBe(env);
    expect(h.calls()).not.toMatch(/^(useradd|groupadd|usermod) /m);
    expect(again.output).not.toContain('== created');
  });

  it('then --check lists only what a person must supply, each with its exact path', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    const check = h.run(['--check']);
    expect(check.code).toBe(1);
    expect(check.output).not.toContain('provision-host.sh creates it');
    const human = check.output.split('== inputs only a person can supply')[1] ?? '';
    for (const path of [
      '/etc/kf/backup-recipient.asc',
      '/etc/kf/credstore.encrypted/backup-decryption-key',
      '/etc/kf/offsite.env',
      '/etc/kf/api/database-url',
      '/etc/kf/drill/database-url',
      // The SeaweedFS binary could not be fetched here, so a person is told where it goes.
      '/usr/local/lib/kf-objects/weed',
      '/etc/kf/checkpoint/anchor-secret-access-key',
      '/etc/kf/migrator/rehearsal-database-url',
      '/etc/kf/alert/webhook-url',
      '/etc/kf/backup/preservation-manifest-key',
    ]) {
      expect(human, path).toContain(`  ${path}`);
    }
    for (const secret of GENERATED) expect(human).not.toContain(`  ${secret}\n`);
    expect(human).toContain('KF_OFFSITE_DESTINATION (empty');

    // Supplying one input removes exactly that line.
    writeFileSync(h.path('/etc/kf/alert/webhook-url'), 'https://alerts.example.org/hook\n', {
      mode: 0o600,
    });
    expect(h.run(['--check']).output).not.toContain('  /etc/kf/alert/webhook-url');
  });

  it('reports a secret file readable beyond its owner instead of silently fixing it', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    writeFileSync(h.path('/etc/kf/api/database-url'), 'postgres://kf_api@db/kf\n');
    chmodSync(h.path('/etc/kf/api/database-url'), 0o644);
    const check = h.run(['--check']);
    expect(mode(h.path('/etc/kf/api/database-url'))).toBe('644');
    expect(check.output).toMatch(/\/etc\/kf\/api\/database-url\n\s+is mode 644/);
  });
});

describe('values it can derive rather than ask for', () => {
  it('routes the drill, worker and storage sweep at the store api.env names, and the drill at the off-site copy', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    const edit = (path: string, pairs: Record<string, string>) => {
      let text = readFileSync(h.path(path), 'utf8');
      for (const [key, value] of Object.entries(pairs)) {
        text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
      }
      writeFileSync(h.path(path), text);
    };
    edit('/etc/kf/api.env', {
      S3_ENDPOINT: 'https://objects.fabric.org',
      S3_REGION: 'eu-1',
      S3_BUCKET_ARTIFACTS: 'fabric-evidence',
      S3_FORCE_PATH_STYLE: 'true',
    });
    edit('/etc/kf/offsite.env', {
      KF_OFFSITE_DESTINATION: 'vault@backup.fabric.org:/srv/kf',
      KF_OFFSITE_LABEL: 'vault-b',
    });
    const again = h.run();
    expect(again.code, again.output).toBe(0);
    for (const path of ['/etc/kf/drill.env', '/etc/kf/worker.env', '/etc/kf/storage/storage.env']) {
      const text = readFileSync(h.path(path), 'utf8');
      expect(text, path).toMatch(/^S3_ENDPOINT=https:\/\/objects\.fabric\.org$/m);
      expect(text, path).toMatch(/^S3_REGION=eu-1$/m);
      expect(text, path).toMatch(/^S3_BUCKET_ARTIFACTS=fabric-evidence$/m);
      // Never the key id: each identity has its own key.
      expect(text, path).not.toMatch(/^S3_ACCESS_KEY_ID=replace-with-api-access-key-id$/m);
    }
    const backup = readFileSync(h.path('/etc/kf/backup.env'), 'utf8');
    expect(backup).toMatch(/^KF_DRILL_OFFSITE_SOURCE=vault@backup\.fabric\.org:\/srv\/kf$/m);
    expect(backup).toMatch(/^KF_DRILL_OFFSITE_LABEL=vault-b$/m);

    // An operator's own choice is never overwritten by a later run.
    edit('/etc/kf/drill.env', { S3_ENDPOINT: 'https://replica.fabric.org' });
    edit('/etc/kf/api.env', { S3_ENDPOINT: 'https://moved.fabric.org' });
    expect(h.run().code).toBe(0);
    expect(readFileSync(h.path('/etc/kf/drill.env'), 'utf8')).toMatch(
      /^S3_ENDPOINT=https:\/\/replica\.fabric\.org$/m,
    );
  });
});

describe('the drill credential and backup recipient', () => {
  it('--generate-recovery-key writes the public key, seals the secret key, hands it over once', () => {
    const h = host();
    const custody = join(h.root, '..', 'recovery-secret.asc');
    const result = h.run(['--generate-recovery-key', custody]);
    expect(result.code, result.output).toBe(0);
    const recipient = readFileSync(h.path('/etc/kf/backup-recipient.asc'), 'utf8');
    expect(recipient).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(recipient).not.toContain('PRIVATE');
    expect(mode(custody)).toBe('600');
    const secret = readFileSync(custody, 'utf8');
    expect(secret).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    expect(readFileSync(h.path('/etc/kf/credstore.encrypted/backup-decryption-key'), 'utf8')).toBe(
      `SEALED\n${secret}`,
    );
    // Sealed from the file by path; the key's bytes never reached a command line.
    expect(h.calls()).toMatch(
      /^systemd-creds encrypt --name=backup-decryption-key \S+recovery-secret\.asc \S+$/m,
    );
    expect(h.calls()).not.toContain('PRIVATE KEY');
    expect(result.output).toContain(`  ${custody}`);
    // It refuses to replace a recovery key that exists.
    const other = join(h.root, '..', 'second.asc');
    expect(h.run(['--generate-recovery-key', other]).code).not.toBe(0);
    expect(existsSync(other)).toBe(false);
  });
});

describe('object-store permissions for orphan collection', () => {
  function withStorage(h: Host, key = 'kf-storage-key') {
    expect(h.run().code).toBe(0);
    writeFileSync(
      h.path('/etc/kf/storage/storage.env'),
      readFileSync(h.path('/etc/kf/storage/storage.env'), 'utf8')
        .replace('http://127.0.0.1:8333', 'https://objects.fabric.org')
        .replace('S3_ACCESS_KEY_ID=kf-storage', `S3_ACCESS_KEY_ID=${key}`)
        .replace('replace-with-organization-uuid', '22222222-2222-4222-8222-222222222222'),
    );
    writeFileSync(h.path('/etc/kf/storage/s3-secret'), 'storage-secret\n', { mode: 0o600 });
  }

  /** A release whose kf-storage probe answers as the store would. */
  function release(h: Host, missing: boolean): string {
    const tree = join(h.root, '..', 'release');
    mkdirSync(join(tree, 'apps', 'kf-storage', 'dist'), { recursive: true });
    for (const dir of ['deploy']) {
      spawnSync('cp', ['-a', join(ROOT, dir), tree]);
    }
    writeFileSync(
      join(tree, 'apps', 'kf-storage', 'dist', 'main.js'),
      missing
        ? `console.error('orphan collection refused: the working-store key kf-storage-key lacks s3:DeleteObjectVersion on bucket kf-artifacts. Grant it the policy kf-storage-orphan-collection');process.exit(1);`
        : `console.warn(JSON.stringify({ ok: true }));`,
    );
    return tree;
  }

  it('--check names the missing permission and the policy when the store refuses', () => {
    const h = host();
    withStorage(h);
    const check = h.run(['--check'], { KF_RELEASE_DIR: release(h, true) });
    expect(check.code).toBe(1);
    expect(check.output).toContain('object-store policy for kf-storage-key');
    expect(check.output).toContain('lacks s3:DeleteObjectVersion');
    // The probe ran as the storage identity, with its own env file, never with the secret.
    expect(h.calls()).toMatch(/^runuser -u kf-storage -- env -i .*--check-permissions$/m);
    expect(h.calls()).not.toContain('storage-secret');
  });

  it('prints the exact policy for the storage key when it cannot apply it', () => {
    const h = host();
    withStorage(h);
    const run = h.run([], { KF_RELEASE_DIR: release(h, false) });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain(
      '== object-store policy kf-storage-orphan-collection for key kf-storage-key',
    );
    expect(run.output).toContain('"arn:aws:s3:::kf-artifacts/ingest/*"');
    expect(run.output).not.toContain('KF_ARTIFACTS_BUCKET');
  });
});

describe("this host's own object store, kf-objects (ADR 0039)", () => {
  const SERVICE_SECRETS = {
    'kf-api': '/etc/kf/api/s3-secret-access-key',
    'kf-worker': '/etc/kf/worker/s3-secret-access-key',
    'kf-storage': '/etc/kf/storage/s3-secret',
    'kf-drill': '/etc/kf/drill/s3-secret-access-key',
  } as const;

  it('generates each service secret, and renders the identities the store reads from them', () => {
    const h = host();
    const run = h.run();
    expect(run.code, run.output).toBe(0);
    const identities = JSON.parse(readFileSync(h.path('/etc/kf/objects/identities.json'), 'utf8'))
      .identities as {
      name: string;
      credentials: { accessKey: string; secretKey: string }[];
      actions: string[];
    }[];
    expect(mode(h.path('/etc/kf/objects/identities.json'))).toBe('600');
    expect(identities.map((identity) => identity.name)).toEqual([
      'kf-objects-admin',
      'kf-api',
      'kf-worker',
      'kf-storage',
      'kf-drill',
    ]);
    for (const [name, path] of Object.entries(SERVICE_SECRETS)) {
      expect(mode(h.path(path)), path).toBe('600');
      const secret = readFileSync(h.path(path), 'utf8');
      expect(secret.length, path).toBeGreaterThanOrEqual(32);
      const identity = identities.find((candidate) => candidate.name === name);
      expect(identity?.credentials).toEqual([{ accessKey: name, secretKey: secret }]);
    }
    expect(identities.find((identity) => identity.name === 'kf-storage')?.actions).toEqual([
      'Read:kf-artifacts',
      'List:kf-artifacts',
      'Write:kf-artifacts/ingest/*',
      'Write:kf-artifacts/document-imports/*',
    ]);
    expect(identities.find((identity) => identity.name === 'kf-drill')?.actions).toEqual([
      'Read:kf-artifacts',
      'List:kf-artifacts',
    ]);
    expect(readFileSync(h.path('/etc/kf/objects-init/objects.env'), 'utf8')).toMatch(
      /^KF_OBJECTS_BUCKETS=kf-artifacts$/m,
    );
    // No secret in the output or any command line, and no policy to print: the store has it.
    const everything = `${run.output}\n${h.calls()}`;
    for (const identity of identities) {
      expect(everything).not.toContain(identity.credentials[0]?.secretKey);
    }
    expect(run.output).not.toContain('== object-store policy');
    // Re-running changes nothing.
    const before = readFileSync(h.path('/etc/kf/objects/identities.json'), 'utf8');
    expect(h.run().output).not.toContain('identities.json');
    expect(readFileSync(h.path('/etc/kf/objects/identities.json'), 'utf8')).toBe(before);
  });

  it('leaves a service routed at another store to its own key, and out of the identities', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    const env = h.path('/etc/kf/drill.env');
    writeFileSync(
      env,
      readFileSync(env, 'utf8').replace('http://127.0.0.1:8333', 'https://replica.fabric.org'),
    );
    rmSync(h.path('/etc/kf/drill/s3-secret-access-key'));
    expect(h.run().code).toBe(0);
    const names = (
      JSON.parse(readFileSync(h.path('/etc/kf/objects/identities.json'), 'utf8')).identities as {
        name: string;
      }[]
    ).map((identity) => identity.name);
    expect(names).not.toContain('kf-drill');
    // Its secret is a person's to supply again, as an empty owner-only placeholder.
    expect(statSync(h.path('/etc/kf/drill/s3-secret-access-key')).size).toBe(0);
  });

  it('refuses a SeaweedFS tarball that is not the pinned one', () => {
    const h = host();
    const fake = join(h.root, '..', 'fake.tar.gz');
    const staging = join(h.root, '..', 'staging');
    mkdirSync(staging);
    writeFileSync(join(staging, 'weed'), '#!/bin/sh\necho not seaweedfs\n', { mode: 0o755 });
    expect(spawnSync('tar', ['-czf', fake, '-C', staging, 'weed']).status).toBe(0);
    const run = h.run([], { KF_OBJECTS_RELEASE_URL: `file://${fake}` });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('REFUSED: the SeaweedFS tarball');
    expect(existsSync(h.path('/usr/local/lib/kf-objects/weed'))).toBe(false);
  });
});

describe('provisioning covers every secret a shipped unit names', () => {
  it('leaves a file, owner-only, at every path the units read a secret from', async () => {
    const { readUnits } =
      await import('../../packages/operations/src/internal/commissioning/units.js');
    const units = await readUnits(join(ROOT, 'deploy', 'systemd'));
    const h = host();
    const custody = join(h.root, '..', 'recovery.asc');
    expect(h.run(['--generate-recovery-key', custody]).code).toBe(0);
    const missing: string[] = [];
    for (const unit of units) {
      for (const path of unit.secretPaths) {
        // The release's own files and a lock that exists only while a migration runs.
        if (path.startsWith('/opt/kf/') || path.startsWith('/run/')) continue;
        if (!existsSync(h.path(path))) missing.push(`${unit.name}: ${path}`);
        else if (Number.parseInt(mode(h.path(path)), 8) & 0o007) {
          missing.push(`${unit.name}: ${path} is world-readable`);
        }
      }
    }
    expect(missing, 'a unit reads a secret provisioning never creates').toEqual([]);
  });
});

describe('the tailnet host (ADR 0039)', () => {
  const NAME = 'kf-host-1.example-tailnet.ts.net';
  const ADDRESS = '100.101.102.103';

  function tailnetHost(state = 'Running'): Host {
    const h = host();
    for (const dir of [
      '/usr/bin',
      '/usr/sbin',
      '/etc/nginx/sites-available',
      '/etc/nginx/sites-enabled',
      '/etc/default',
    ]) {
      mkdirSync(h.path(dir), { recursive: true });
    }
    writeFileSync(
      h.path('/usr/bin/tailscale'),
      `#!/usr/bin/env bash\n[ "$1 $2" = "status --json" ] || exit 2\ncat <<'JSON'\n${JSON.stringify(
        {
          BackendState: state,
          Self: { DNSName: `${NAME}.`, TailscaleIPs: [ADDRESS, 'fd7a:115c:a1e0::1'] },
        },
      )}\nJSON\n`,
      { mode: 0o755 },
    );
    writeFileSync(h.path('/usr/sbin/nginx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(h.path('/etc/nginx/sites-enabled/default'), 'server { listen 80; }\n');
    return h;
  }

  it('lists the host requirements and the tailnet inputs on a bare host', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    const output = h.run(['--check']).output;
    expect(output).toContain('tailscale (/usr/bin/tailscale)');
    expect(output).toContain('nginx (/usr/sbin/nginx)');
    expect(output).toContain('KF_TAILNET_HOSTNAME');
    expect(output).toContain('KF_TAILNET_ADDRESS');
    expect(output).toContain('TS_PERMIT_CERT_UID=kf-tls');
    expect(output).toContain('/etc/kf/tls/tailnet.crt');
    expect(mode(h.path('/etc/kf/tls'))).toBe('750');
    expect(mode(h.path('/etc/kf/tailnet.env'))).toBe('640');
  });

  it('fills the name and address from tailscale, renders nginx for them, and says what is left', () => {
    const h = tailnetHost();
    expect(h.run().code).toBe(0);
    const env = readFileSync(h.path('/etc/kf/tailnet.env'), 'utf8');
    expect(env).toMatch(new RegExp(`^KF_TAILNET_HOSTNAME=${NAME.replaceAll('.', '\\.')}$`, 'm'));
    expect(env).toMatch(new RegExp(`^KF_TAILNET_ADDRESS=${ADDRESS.replaceAll('.', '\\.')}$`, 'm'));

    const site = readFileSync(h.path('/etc/nginx/sites-available/knowledge-fabric.conf'), 'utf8');
    expect(site).not.toMatch(/KF_TAILNET_(ADDRESS|HOSTNAME)/);
    const listens = [...site.matchAll(/^\s*listen\s+([^;]+);/gm)].map((m) => m[1]!);
    expect(listens.length).toBeGreaterThan(3);
    for (const listen of listens) expect(listen.startsWith(`${ADDRESS}:`), listen).toBe(true);
    expect(site).toContain(`server_name ${NAME};`);

    const left = h.run(['--check']).output;
    expect(left).toContain('/etc/nginx/sites-enabled/default');
    expect(left).toContain('TS_PERMIT_CERT_UID=kf-tls');
    expect(left).toContain('/etc/kf/tls/tailnet.crt');
    expect(left).not.toContain('tailscale (/usr/bin/tailscale)');
    expect(left).not.toContain('KF_TAILNET_HOSTNAME');

    rmSync(h.path('/etc/nginx/sites-enabled/default'));
    writeFileSync(h.path('/etc/default/tailscaled'), 'PORT="41641"\nTS_PERMIT_CERT_UID=kf-tls\n');
    writeFileSync(h.path('/etc/kf/tls/tailnet.crt'), 'certificate\n');
    const done = h.run(['--check']).output;
    for (const item of ['sites-enabled/default', 'TS_PERMIT_CERT_UID', 'tailnet.crt', 'nginx (']) {
      expect(done).not.toContain(item);
    }
  });

  it('says so when the host is not up on the tailnet, and fills nothing', () => {
    const h = tailnetHost('NeedsLogin');
    expect(h.run().code).toBe(0);
    expect(h.run(['--check']).output).toContain('not up on the tailnet (state: NeedsLogin)');
    expect(readFileSync(h.path('/etc/kf/tailnet.env'), 'utf8')).toMatch(/^KF_TAILNET_HOSTNAME=$/m);
    expect(existsSync(h.path('/etc/nginx/sites-available/knowledge-fabric.conf'))).toBe(false);
  });

  it('reports a configured name that is not the one tailscale knows', () => {
    const h = tailnetHost();
    expect(h.run().code).toBe(0);
    const env = h.path('/etc/kf/tailnet.env');
    writeFileSync(
      env,
      readFileSync(env, 'utf8').replace(
        /^KF_TAILNET_HOSTNAME=.*$/m,
        'KF_TAILNET_HOSTNAME=old.example-tailnet.ts.net',
      ),
    );
    expect(h.run(['--check']).output).toContain(`but tailscale reports ${NAME}`);
  });

  it('checks none of it on a private-CA host', () => {
    const h = host();
    expect(h.run().code).toBe(0);
    const env = h.path('/etc/kf/tailnet.env');
    writeFileSync(
      env,
      readFileSync(env, 'utf8').replace(/^KF_HOST_ACCESS=tailnet$/m, 'KF_HOST_ACCESS=private-ca'),
    );
    const output = h.run(['--check']).output;
    for (const item of [
      'tailscale (',
      'KF_TAILNET_HOSTNAME',
      'TS_PERMIT_CERT_UID',
      'tailnet.crt',
    ]) {
      expect(output).not.toContain(item);
    }
  });
});
