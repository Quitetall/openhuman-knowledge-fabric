// Reviewed file composition is not proof of loaded PID1 state or service startup.
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMISSIONING_DEFAULTS } from './internal/commissioning/contracts.js';
import { parseUnit, readUnits, unitProvenance } from './internal/commissioning/units.js';

const SYSTEMD = join(import.meta.dirname, '../../../deploy/systemd');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kf-unit-composition-'));
  roots.push(root);
  const installed = join(root, 'installed');
  const shipped = join(root, 'shipped');
  await mkdir(installed);
  await mkdir(shipped);
  for (const name of ['kf-api.service', 'kf-checkpoint.service']) {
    const user = name.slice(0, -'.service'.length);
    const text = `[Unit]\nOnFailure=kf-alert@%n.service\n[Service]\nUser=${user}\n`;
    for (const path of [installed, shipped]) await writeFile(join(path, name), text);
  }
  return {
    installed,
    shipped,
    inputs: {
      ...COMMISSIONING_DEFAULTS,
      systemdDirectory: installed,
      shippedUnitDirectory: shipped,
    },
  };
}
async function drop(root: string, directory: string, name: string, text: string) {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, name), text);
}

describe('commissioning unit file composition', () => {
  it('sees an override identity and refuses it rather than reporting the base as unchanged', async () => {
    const f = await fixture();
    await drop(f.installed, 'kf-api.service.d', 'override.conf', '[Service]\nUser=kf-checkpoint\n');
    expect((await readUnits(f.installed))[0]?.user).toBe('kf-checkpoint');
    const result = await unitProvenance(f.inputs);
    expect(result.status).toBe('unsatisfied');
    expect(result.observed?.['altered']).toContain('kf-api.service');
  });

  it('sees generic and dash-prefix drop-ins, with filename order and specific-file precedence', async () => {
    const f = await fixture();
    await drop(f.installed, 'service.d', '10-common.conf', '[Service]\nUser=common\n');
    await drop(f.installed, 'kf-.service.d', '20-family.conf', '[Service]\nUser=family\n');
    await drop(f.installed, 'service.d', '30-same.conf', '[Service]\nUser=generic\n');
    await drop(f.installed, 'kf-api.service.d', '30-same.conf', '[Service]\nUser=specific\n');
    expect((await readUnits(f.installed))[0]?.user).toBe('specific');
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
  });

  it('clears obsolete environment files, credential sources and command-local paths on resets', () => {
    const facts = parseUnit(
      'x.service',
      '[Service]\n' +
        'EnvironmentFile=/legacy.env\nLoadCredential=db:/legacy-db\n' +
        'Environment=DATABASE_URL_FILE=/legacy-env\n' +
        'ExecStartPre=/usr/bin/test -s /legacy-pre\n' +
        'ExecStart=/usr/bin/env DATABASE_URL_FILE=/legacy-command node main.js\n' +
        'EnvironmentFile=\nLoadCredential=\nEnvironment=\nExecStartPre=\nExecStart=\n' +
        'LoadCredential=db:/run/current-db\nExecStart=/usr/bin/node native.js\n',
    );
    expect(facts.secretPaths).toEqual(['/run/current-db']);
  });

  it('respects per-variable Environment replacement, not the union of superseded secret paths', () => {
    expect(
      parseUnit(
        'x.service',
        '[Service]\nEnvironment=DATABASE_URL_FILE=/old\n' + 'Environment=DATABASE_URL_FILE=/new\n',
      ).secretPaths,
    ).toEqual(['/new']);
  });

  it('accepts the exact role-specific native template, but refuses a changed or additional file', async () => {
    const f = await fixture();
    const name = 'application-api-workstation-credentials.conf';
    const text = await readFile(join(import.meta.dirname, '../../../deploy/systemd', name), 'utf8');
    await writeFile(join(f.shipped, name), text);
    await drop(f.installed, 'kf-api.service.d', name, text);
    expect((await unitProvenance(f.inputs)).status).toBe('satisfied');
    await drop(f.installed, 'kf-api.service.d', '99-extra.conf', '# no-op but unreviewed\n');
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
    await rm(join(f.installed, 'kf-api.service.d', '99-extra.conf'));
    await drop(f.installed, 'kf-api.service.d', name, text + '\n[Service]\nUser=kf-checkpoint\n');
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
  });

  it('does not accept a native template assigned to a different role', async () => {
    const f = await fixture();
    const name = 'application-worker-workstation-credentials.conf';
    const text = await readFile(join(import.meta.dirname, '../../../deploy/systemd', name), 'utf8');
    await writeFile(join(f.shipped, name), text);
    await drop(f.installed, 'kf-api.service.d', name, text);
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
  });

  it('orders ASCII filenames independently of locale collation and directory discovery order', async () => {
    const f = await fixture();
    await drop(f.installed, 'kf-api.service.d', 'Z.conf', '[Service]\nUser=upper\n');
    await drop(f.installed, 'service.d', 'a.conf', '[Service]\nUser=lower\n');
    const facts = (await readUnits(f.installed))[0]!;
    expect(facts.user).toBe('lower');
    expect(facts.dropIns?.map((fragment) => fragment.relativePath)).toEqual([
      'kf-api.service.d/Z.conf',
      'service.d/a.conf',
    ]);
  });

  it('composes a template with an explicit instance base, selecting instance filenames last', async () => {
    const f = await fixture();
    await writeFile(join(f.installed, 'kf-alert@api.service'), '[Service]\nUser=base\n');
    await drop(f.installed, 'kf-alert@.service.d', '10-user.conf', '[Service]\nUser=template\n');
    await drop(f.installed, 'kf-alert@api.service.d', '10-user.conf', '[Service]\nUser=instance\n');
    const facts = await readUnits(f.installed, new Set(['kf-alert@api.service']));
    expect(facts[0]?.user).toBe('instance');
    expect(facts[0]?.dropIns?.map((fragment) => fragment.relativePath)).toEqual([
      'kf-alert@api.service.d/10-user.conf',
    ]);
  });

  it('includes recursive instance-prefix directories in systemd precedence order', async () => {
    const f = await fixture();
    const name = 'kf-alert@api.service';
    await writeFile(join(f.installed, name), '[Service]\nUser=base\n');
    await drop(f.installed, 'kf-@.service.d', '20-user.conf', '[Service]\nUser=prefix-template\n');
    await drop(
      f.installed,
      'kf-@api.service.d',
      '20-user.conf',
      '[Service]\nUser=prefix-instance\n',
    );
    const user = async () => (await readUnits(f.installed, new Set([name])))[0]?.user;
    expect(await user()).toBe('prefix-instance');
    await drop(
      f.installed,
      'kf-@api.service.d',
      '30-user.conf',
      '[Service]\nUser=less-specific-instance\n',
    );
    await drop(f.installed, 'kf-.service.d', '30-user.conf', '[Service]\nUser=plain-prefix\n');
    expect(await user()).toBe('plain-prefix');
    await drop(
      f.installed,
      'kf-alert@.service.d',
      '30-user.conf',
      '[Service]\nUser=exact-template\n',
    );
    expect(await user()).toBe('exact-template');
    await drop(f.installed, `${name}.d`, '30-user.conf', '[Service]\nUser=exact-instance\n');
    expect(await user()).toBe('exact-instance');
  });

  it.each(['oversized', 'invalid-utf8'])('refuses an %s fragment', async (kind) => {
    const f = await fixture();
    const bytes = kind === 'oversized' ? Buffer.alloc(1024 * 1024 + 1, 32) : Buffer.from([0xff]);
    await mkdir(join(f.installed, 'kf-api.service.d'));
    await writeFile(join(f.installed, 'kf-api.service.d/x.conf'), bytes);
    expect((await unitProvenance(f.inputs)).status).toBe('unverifiable');
  });

  it('restricts discovery to shipped bases without reading unrelated symlinked services', async () => {
    const f = await fixture();
    await symlink('/does-not-exist', join(f.installed, 'unrelated.service'));
    await drop(f.installed, 'unrelated.service.d', 'x.conf', '[Service]\nUser=root\n');
    expect((await unitProvenance(f.inputs)).status).toBe('satisfied');
  });

  it.each(['base', 'fragment', 'directory'])(
    'refuses a symlinked %s rather than trusting its target',
    async (kind) => {
      const f = await fixture();
      if (kind === 'base') {
        await rm(join(f.installed, 'kf-api.service'));
        await symlink(join(f.shipped, 'kf-api.service'), join(f.installed, 'kf-api.service'));
      } else if (kind === 'fragment') {
        await mkdir(join(f.installed, 'kf-api.service.d'));
        await symlink(
          join(f.shipped, 'kf-api.service'),
          join(f.installed, 'kf-api.service.d/x.conf'),
        );
      } else {
        await symlink(f.shipped, join(f.installed, 'kf-api.service.d'));
      }
      expect((await unitProvenance(f.inputs)).status).toBe('unverifiable');
    },
  );

  it('does not inherit a section from the preceding file', async () => {
    const f = await fixture();
    await drop(f.installed, 'kf-api.service.d', 'x.conf', 'User=root\n');
    expect((await readUnits(f.installed))[0]?.user).toBe('kf-api');
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
  });

  it('honors scalar and OnFailure resets, sections, quoted assignments and continuations', () => {
    const facts = parseUnit(
      'x.service',
      '[Unit]\nOnFailure=a.service\nOnFailure=b.service\n' +
        '[Service]\nUser=old\nEnvironment="DATABASE_URL_FILE=/first" OTHER_FILE=/other\n' +
        'ExecStart=/usr/bin/env \\\n DATABASE_URL_FILE=/command node main.js\n' +
        '[Install]\nUser=ignored\nEnvironmentFile=/ignored\n' +
        '[Unit]\nOnFailure=\nOnFailure=c.service\n[Service]\nUser=\n' +
        'Environment="DATABASE_URL_FILE=/last"\n',
    );
    expect(facts.user).toBeNull();
    expect(facts.onFailure).toBe('c.service');
    expect(facts.secretPaths).toEqual(['/command', '/last', '/other']);
    expect(
      parseUnit('x.service', '[Unit]\nOnFailure=a.service\nOnFailure=b.service\n').onFailure,
    ).toBe('a.service b.service');
  });

  it('requires unchanged base bytes even when the native drop-in is exact', async () => {
    const f = await fixture();
    const name = 'application-api-workstation-credentials.conf';
    const text = await readFile(join(SYSTEMD, name), 'utf8');
    await writeFile(join(f.shipped, name), text);
    await drop(f.installed, 'kf-api.service.d', name, text);
    await writeFile(
      join(f.installed, 'kf-api.service'),
      '[Unit]\nOnFailure=kf-alert@%n.service\n[Service]\nUser=other\n',
    );
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
  });

  it('refuses missing frozen templates and renamed otherwise-identical drop-ins', async () => {
    const f = await fixture();
    const name = 'application-api-workstation-credentials.conf';
    const text = await readFile(join(SYSTEMD, name), 'utf8');
    await drop(f.installed, 'kf-api.service.d', name, text);
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
    await writeFile(join(f.shipped, name), text);
    await rm(join(f.installed, 'kf-api.service.d', name));
    await drop(f.installed, 'kf-api.service.d', 'local.conf', text);
    expect((await unitProvenance(f.inputs)).status).toBe('unsatisfied');
  });

  it('accepts all twelve shipped native bindings together, with each role still isolated', async () => {
    const f = await fixture();
    for (const name of await readdir(SYSTEMD)) {
      if (!name.endsWith('.service') && !name.endsWith('.conf')) continue;
      const bytes = await readFile(join(SYSTEMD, name));
      await writeFile(join(f.shipped, name), bytes);
      if (name.endsWith('.service')) await writeFile(join(f.installed, name), bytes);
    }
    const bindings = [
      ['kf-api.service', 'application-api-workstation-credentials.conf'],
      ['kf-worker.service', 'application-worker-workstation-credentials.conf'],
      [
        'kf-compiler-determinism.service',
        'application-compiler-determinism-workstation-credentials.conf',
      ],
      ['kf-attestor.service', 'application-attestor-workstation-credentials.conf'],
      ['kf-checkpoint.service', 'application-checkpoint-workstation-credentials.conf'],
      ['kf-storage.service', 'application-storage-workstation-credentials.conf'],
      ['kf-readiness.service', 'application-readiness-workstation-credentials.conf'],
      ['kf-backup.service', 'backup-workstation-credentials.conf'],
      ['kf-backup-offsite.service', 'offsite-b2-workstation-credentials.conf'],
      ['kf-restore-drill.service', 'drill-b2-workstation-credentials.conf'],
      ['kf-alert@.service', 'alert-workstation-credentials.conf'],
      ['kf-alert-heartbeat.service', 'alert-heartbeat-workstation-credentials.conf'],
    ];
    for (const [name, template] of bindings) {
      await drop(
        f.installed,
        `${name}.d`,
        template!,
        await readFile(join(SYSTEMD, template!), 'utf8'),
      );
    }
    const facts = await readUnits(f.installed);
    const api = facts.find((unit) => unit.name === 'kf-api.service')!;
    expect(api.secretPaths).toContain(
      '/run/kf-workstation-application-api-credentials/current/database-url',
    );
    expect(api.secretPaths).not.toContain('/etc/kf/api.env');
    const result = await unitProvenance(f.inputs);
    expect(result.status, result.detail).toBe('satisfied');
    expect(result.detail).toContain('not proof of loaded PID1 state');
    for (const [name, template] of bindings) {
      const text = await readFile(join(SYSTEMD, template!), 'utf8');
      await drop(f.installed, `${name}.d`, template!, text + '\n# unreviewed edit\n');
      expect((await unitProvenance(f.inputs)).observed?.['altered']).toBe(name);
      await drop(f.installed, `${name}.d`, template!, text);
    }
  });
});
