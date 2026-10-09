import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMISSIONING_DEFAULTS } from './index.js';
import { parseUnit, secretPosture } from './internal/commissioning/units.js';
import { observeSecretFile } from './internal/commissioning/secret-files.js';
import {
  publicConfigurationCatalog,
  publicConfigurationVerdict,
} from './internal/commissioning/public-configuration.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kf-posture-'));
  roots.push(root);
  const units = join(root, 'units');
  await mkdir(units);
  const secret = join(root, 'database-url');
  await writeFile(secret, 'public fake credential');
  await chmod(secret, 0o600);
  await writeFile(
    join(units, 'kf-api.service'),
    `[Service]\nUser=kf-api\nEnvironment=DATABASE_URL_FILE=${secret}\n`,
  );
  const passwd = join(root, 'passwd'),
    group = join(root, 'group');
  await writeFile(
    passwd,
    'root:x:0:0::/:/bin/sh\nkf-api:x:1101:1101::/:/bin/false\noutsider:x:1102:1102::/:/bin/false\n',
  );
  await writeFile(group, 'root:x:0:\nkf-api:x:1101:\noutsider:x:1102:\n');
  const observation = {
    uid: 1101,
    gid: 1101,
    mode: 0o600,
    nlink: 1,
    size: 22,
    regular: true,
    acl: 'user::rw-\ngroup::---\nother::---\n',
  };
  const inputs = {
    ...COMMISSIONING_DEFAULTS,
    systemdDirectory: units,
    shippedUnitDirectory: units,
    passwdPath: passwd,
    groupPath: group,
    secretFileObservation: async () => observation,
  };
  return { root, units, secret, passwd, observation, inputs };
}
describe('commissioning secret-source metadata and public projection classification', () => {
  it('accepts the controlled intended owner without claiming live credential delivery', async () => {
    const f = await fixture();
    const result = await secretPosture(f.inputs);
    expect(result.status, result.detail).toBe('satisfied');
    expect(result.detail).toContain('not live credential delivery');
  });
  it.each([
    ['unrelated owner', { uid: 1102 }],
    [
      'named ACL reader',
      { mode: 0o640, acl: 'user::rw-\nuser:1102:r--\ngroup::---\nmask::r--\nother::---\n' },
    ],
    ['hard link', { nlink: 2 }],
    ['symlink or nonregular file', { regular: false }],
    ['empty secret', { size: 0 }],
    ['world read', { mode: 0o604 }],
  ])('refuses %s metadata', async (_name, mutation) => {
    const f = await fixture();
    Object.assign(f.observation, mutation);
    expect((await secretPosture(f.inputs)).status).not.toBe('satisfied');
  });
  it('refuses a differently named account sharing the entitled UID', async () => {
    const f = await fixture();
    await writeFile(
      f.passwd,
      'kf-api:x:1101:1101::/:/bin/false\noutsider:x:1101:1102::/:/bin/false\n',
    );
    expect((await secretPosture(f.inputs)).status).toBe('unsatisfied');
  });
  it('keeps root as trusted custodian, without granting arbitrary named readers', async () => {
    const f = await fixture();
    f.observation.uid = 0;
    expect((await secretPosture(f.inputs)).status).toBe('satisfied');
    f.observation.mode = 0o640;
    f.observation.acl = 'user::rw-\nuser:1102:r--\ngroup::---\nmask::r--\nother::---\n';
    expect((await secretPosture(f.inputs)).status).toBe('unsatisfied');
  });
  it('does not disclose a failed observer error or return a pass', async () => {
    const f = await fixture();
    const result = await secretPosture({
      ...f.inputs,
      secretFileObservation: async () => {
        throw new Error('PUBLIC_UNTRUSTED_DIAGNOSTIC');
      },
    });
    expect(result.status).toBe('unverifiable');
    expect(JSON.stringify(result)).not.toContain('PUBLIC_UNTRUSTED_DIAGNOSTIC');
  });
  it('does not count the exact API ontology projection as a secret, but keeps unknown presence guards', () => {
    const facts = parseUnit(
      'kf-api.service',
      '[Service]\nExecStartPre=/usr/bin/test -s /opt/kf/generated/projections/knowledge-fabric.projections.json\nExecStartPre=/usr/bin/test -s /etc/kf/unknown-private-file\n',
    );
    expect(facts.secretPaths).toEqual(['/etc/kf/unknown-private-file']);
    expect(
      parseUnit(
        'foreign.service',
        '[Service]\nExecStartPre=/usr/bin/test -s /opt/kf/generated/projections/knowledge-fabric.projections.json\n',
      ).secretPaths,
    ).toHaveLength(1);
  });
  it('distinguishes PID1 source paths from direct paths and records the requested credential purpose', () => {
    const facts = parseUnit(
      'kf-api.service',
      '[Service]\nLoadCredential=database-url:/run/kf-workstation-application-api-credentials/current/database-url\nEnvironment=OTHER_FILE=/etc/private\n',
    );
    expect(facts).toMatchObject({
      secretSources: [
        {
          path: '/run/kf-workstation-application-api-credentials/current/database-url',
          kind: 'pid1-source',
          credential: 'database-url',
        },
        { path: '/etc/private', kind: 'direct' },
      ],
    });
  });
  it('recognizes only the exact role-specific public configuration, not a broad directory exception', () => {
    const facts = parseUnit(
      'kf-api.service',
      '[Service]\nEnvironmentFile=/etc/kf/application-public/api.env\nEnvironmentFile=/etc/kf/application-public/unknown.env\n',
    );
    expect(facts.secretPaths).toEqual(['/etc/kf/application-public/unknown.env']);
    expect(facts).toMatchObject({
      publicConfigurationPaths: ['/etc/kf/application-public/api.env'],
    });
  });
  it("admits the worker's public file for the determinism re-run, and no other unit's", () => {
    const own = parseUnit(
      'kf-compiler-determinism.service',
      '[Service]\nEnvironmentFile=/etc/kf/application-public/worker.env\n',
    );
    expect(own.secretPaths).toEqual([]);
    expect(own.publicConfigurationPaths).toEqual(['/etc/kf/application-public/worker.env']);
    const other = parseUnit(
      'kf-compiler-determinism.service',
      '[Service]\nEnvironmentFile=/etc/kf/application-public/api.env\n',
    );
    expect(other.secretPaths).toEqual(['/etc/kf/application-public/api.env']);
  });
  it('keeps encrypted PID1 sources distinct and does not treat unknown EnvironmentFiles as public', () => {
    const facts = parseUnit(
      'kf-api.service',
      '[Service]\nLoadCredentialEncrypted=key:/etc/encrypted\nEnvironmentFile=/etc/kf/application-public/worker.env\n',
    );
    expect(facts.secretSources).toContainEqual({
      path: '/etc/encrypted',
      kind: 'encrypted-pid1-source',
      credential: 'key',
    });
    expect(facts.secretPaths).toContain('/etc/kf/application-public/worker.env');
  });
  it('refuses unencrypted PID1 source ownership by the service rather than root', async () => {
    const f = await fixture();
    await writeFile(
      join(f.units, 'kf-api.service'),
      `[Service]\nUser=kf-api\nLoadCredential=database-url:${f.secret}\n`,
    );
    expect((await secretPosture(f.inputs)).status).toBe('unsatisfied');
    f.observation.uid = 0;
    expect((await secretPosture(f.inputs)).status).toBe('satisfied');
  });
  it.each([
    ['unknown named UID', 'user::rw-\nuser:9999:r--\ngroup::---\nmask::r--\nother::---\n'],
    ['unknown named GID', 'user::rw-\ngroup::---\ngroup:9999:r--\nmask::r--\nother::---\n'],
    ['malformed ACL', 'garbage'],
    ['duplicate ACL', 'user::rw-\nuser::rw-\ngroup::r--\nother::---\n'],
    ['missing mask', 'user::rw-\nuser:1101:r--\ngroup::r--\nother::---\n'],
  ])('does not pass %s', async (_name, acl) => {
    const f = await fixture();
    f.observation.mode = 0o640;
    f.observation.acl = acl;
    expect((await secretPosture(f.inputs)).status).toBe('unverifiable');
  });
  it('permits only an effective entitled named ACL reader and refuses surplus groups', async () => {
    const f = await fixture();
    f.observation.uid = 0;
    f.observation.mode = 0o640;
    f.observation.acl = 'user::rw-\nuser:1101:r--\ngroup::---\nmask::r--\nother::---\n';
    expect((await secretPosture(f.inputs)).status).toBe('satisfied');
    f.observation.acl = 'user::rw-\ngroup::---\ngroup:1102:r--\nmask::r--\nother::---\n';
    expect((await secretPosture(f.inputs)).status).toBe('unsatisfied');
  });
  it('observes real files without returning contents and refuses final-component links', async () => {
    const f = await fixture();
    const observation = await observeSecretFile(f.secret);
    expect(observation.nlink).toBe(1);
    expect(observation.size).toBe(22);
    expect(JSON.stringify(observation)).not.toContain('public fake credential');
    const alias = join(f.root, 'alias');
    await symlink(f.secret, alias);
    await expect(observeSecretFile(alias)).rejects.toThrow();
    await rm(alias);
    await link(f.secret, alias);
    expect((await observeSecretFile(f.secret)).nlink).toBe(2);
  });
  it('validates public config before allowing it to leave the secret set', async () => {
    const f = await fixture();
    const catalogPath = join(
      import.meta.dirname,
      '../../../deploy/systemd/application-public-fields.json',
    );
    await writeFile(join(f.units, 'application-public-fields.json'), await readFile(catalogPath));
    await writeFile(
      join(f.units, 'kf-api.service'),
      `[Service]\nUser=kf-api\nEnvironment=DATABASE_URL_FILE=${f.secret}\nEnvironmentFile=/etc/kf/application-public/api.env\n`,
    );
    const catalog = await publicConfigurationCatalog(f.units);
    const text =
      catalog.api.required
        .map(
          (name) =>
            `${name}=${name.includes('ENDPOINT') || name === 'OIDC_ISSUER' || name === 'OIDC_JWKS_URI' ? 'https://public.example' : 'public-value'}`,
        )
        .join('\n') + '\n';
    const publicMetadata = {
      text,
      uid: 0,
      mode: 0o644,
      nlink: 1,
      size: Buffer.byteLength(text),
      regular: true,
    };
    const inputs = { ...f.inputs, publicFileObservation: async () => publicMetadata };
    expect((await secretPosture(inputs)).status).toBe('satisfied');
    publicMetadata.text += 'DATABASE_URL=PUBLIC_NOT_TO_BE_ECHOED\n';
    publicMetadata.size = Buffer.byteLength(publicMetadata.text);
    const result = await secretPosture(inputs);
    expect(result.status).toBe('unverifiable');
    expect(JSON.stringify(result)).not.toContain('PUBLIC_NOT_TO_BE_ECHOED');
  });
  it.each([
    ['duplicate', 'WORKER_CONCURRENCY=1\nWORKER_CONCURRENCY=2\n'],
    ['loader', 'NODE_OPTIONS=--require=/public\n'],
    ['credential in URL', 'S3_ENDPOINT=https://user:PUBLIC_SECRET@public.example\n'],
    ['URL query', 'S3_ENDPOINT=https://public.example?key=PUBLIC_SECRET\n'],
    ['URL fragment', 'S3_ENDPOINT=https://public.example#PUBLIC_SECRET\n'],
    ['remote cleartext', 'S3_ENDPOINT=http://public.example\n'],
    ['path traversal', 'LIMINAL_COMPILER_PATH=/public/../elsewhere\n'],
    ['backslash', 'WORKER_CONCURRENCY=1\\\n'],
    ['ambiguous quote', 'WORKER_CONCURRENCY="1\n'],
    ['unknown', 'UNKNOWN=PUBLIC_SECRET\n'],
  ])('refuses %s public content without echoing it', async (_name, text) => {
    const catalog = await publicConfigurationCatalog(
      join(import.meta.dirname, '../../../deploy/systemd'),
    );
    const result = publicConfigurationVerdict(
      { text, uid: 0, mode: 0o644, nlink: 1, size: Buffer.byteLength(text), regular: true },
      'worker',
      catalog,
    );
    expect(result.status).toBe('unverifiable');
    expect(JSON.stringify(result)).not.toContain('PUBLIC_SECRET');
  });
  it.each([{ uid: 1102 }, { mode: 0o666 }, { nlink: 2 }, { regular: false }])(
    'refuses unsafe public configuration metadata %j',
    async (mutation) => {
      const catalog = await publicConfigurationCatalog(
        join(import.meta.dirname, '../../../deploy/systemd'),
      );
      expect(
        publicConfigurationVerdict(
          { text: '', uid: 0, mode: 0o644, nlink: 1, size: 0, regular: true, ...mutation },
          'readiness',
          catalog,
        ).status,
      ).toBe('unsatisfied');
    },
  );
});
