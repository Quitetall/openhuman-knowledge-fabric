import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMISSIONING_CHECKS, COMMISSIONING_DEFAULTS } from './index.js';
import type { CommissioningInputs } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kf-manager-observation-'));
  roots.push(root);
  const installed = join(root, 'installed'),
    shipped = join(root, 'shipped');
  await mkdir(installed);
  await mkdir(shipped);
  const units: Record<string, string>[] = [];
  for (const name of ['kf-api.service', 'kf-checkpoint.service']) {
    const user = name.slice(0, -'.service'.length);
    const text = `[Unit]\nOnFailure=kf-alert@%n.service\n[Service]\nUser=${user}\nGroup=${user}\nNoNewPrivileges=yes\nMemorySwapMax=0\nLimitCORE=0\n`;
    for (const directory of [installed, shipped]) await writeFile(join(directory, name), text);
    units.push(properties(name, user, join(installed, name)));
  }
  const snapshot = { unitPaths: [installed], units };
  const inputs = {
    ...COMMISSIONING_DEFAULTS,
    systemdDirectory: installed,
    shippedUnitDirectory: shipped,
    systemdObservation: async () => snapshot,
  };
  return { installed, shipped, snapshot, inputs };
}
function properties(name: string, user: string, fragment: string): Record<string, string> {
  return {
    Id: name,
    Names: name,
    LoadState: 'loaded',
    FragmentPath: fragment,
    DropInPaths: '',
    NeedDaemonReload: 'no',
    Transient: 'no',
    User: user,
    Group: user,
    DynamicUser: 'no',
    OnFailure: `kf-alert@${name}.service`,
    NoNewPrivileges: 'yes',
    MemorySwapMax: '0',
    LimitCORE: '0',
    LimitCORESoft: '0',
  };
}
const run = (inputs: CommissioningInputs) => {
  const check = COMMISSIONING_CHECKS.find((check) => check.id === 'systemd_loaded_units');
  if (!check) throw new Error('required system manager check absent');
  return check.run(inputs);
};

describe('commissioning uses loaded manager observations, not only installed files', () => {
  it('registers the runtime check so the CLI cannot omit it', () => {
    expect(COMMISSIONING_CHECKS.some((check) => check.id === 'systemd_loaded_units')).toBe(true);
  });
  it('accepts exact loaded metadata but makes no startup/reboot claim', async () => {
    const f = await fixture();
    const result = await run(f.inputs);
    expect(result.status, result.detail).toBe('satisfied');
    expect(result.detail).toContain('not startup or reboot evidence');
  });
  it.each([
    ['NeedDaemonReload', 'yes'],
    ['Transient', 'yes'],
    ['User', 'kf-checkpoint'],
    ['Group', 'root'],
    ['DynamicUser', 'yes'],
    ['FragmentPath', '/run/systemd/transient/kf-api.service'],
    ['DropInPaths', '/usr/lib/systemd/system/kf-api.service.d/foreign.conf'],
    ['Names', 'kf-api.service unreviewed-alias.service'],
    ['LoadState', 'not-found'],
    ['OnFailure', ''],
    ['NoNewPrivileges', 'no'],
    ['MemorySwapMax', 'infinity'],
    ['LimitCORE', 'infinity'],
    ['LimitCORESoft', 'infinity'],
  ])('refuses loaded %s=%s even while every installed base byte matches', async (key, value) => {
    const f = await fixture();
    f.snapshot.units[0]![key] = value;
    expect((await run(f.inputs)).status).toBe('unsatisfied');
  });
  it('refuses missing and duplicate observations rather than passing an incomplete view', async () => {
    const f = await fixture();
    const original = f.snapshot.units[1]!;
    f.snapshot.units.pop();
    expect((await run(f.inputs)).status).toBe('unverifiable');
    f.snapshot.units.push(original, original);
    expect((await run(f.inputs)).status).toBe('unverifiable');
  });
  it.each([
    'property omission',
    'control bytes',
    'unscoped unit',
    'invalid load path',
    'empty load paths',
  ])('refuses %s without exposing raw observation values', async (fault) => {
    const f = await fixture();
    if (fault === 'property omission') delete f.snapshot.units[0]!.Group;
    if (fault === 'control bytes') f.snapshot.units[0]!.User = 'PUBLIC_UNTRUSTED\nOUTPUT';
    if (fault === 'unscoped unit')
      f.snapshot.units.push(properties('foreign.service', 'root', '/run/foreign.service'));
    if (fault === 'invalid load path') f.snapshot.unitPaths.push('/run/../etc');
    if (fault === 'empty load paths') f.snapshot.unitPaths = [];
    const result = await run(f.inputs);
    expect(result.status).toBe('unverifiable');
    expect(result.detail).not.toContain('PUBLIC_UNTRUSTED');
  });
  it('refuses a declared directory outside manager load paths', async () => {
    const f = await fixture();
    f.snapshot.unitPaths = ['/run/systemd/system'];
    expect((await run(f.inputs)).status).toBe('unsatisfied');
  });
  it('refuses source drift even when reported properties are unchanged', async () => {
    const f = await fixture();
    await writeFile(join(f.installed, 'kf-api.service'), '[Service]\nUser=kf-api\n');
    expect((await run(f.inputs)).status).toBe('unsatisfied');
  });
  it('refuses a failed collector without echoing untrusted stderr or secret-shaped output', async () => {
    const f = await fixture();
    const result = await run({
      ...f.inputs,
      systemdObservation: async () => {
        throw new Error('SECRET_SHAPED_UNTRUSTED_OUTPUT');
      },
    });
    expect(result.status).toBe('unverifiable');
    expect(JSON.stringify(result)).not.toContain('SECRET_SHAPED_UNTRUSTED_OUTPUT');
  });
  it('accepts the exact native binding only when PID1 lists its exact selected path', async () => {
    const f = await fixture();
    const template = 'application-api-workstation-credentials.conf';
    const text = await readFile(
      join(import.meta.dirname, '../../../deploy/systemd', template),
      'utf8',
    );
    await writeFile(join(f.shipped, template), text);
    const directory = join(f.installed, 'kf-api.service.d');
    await mkdir(directory);
    await writeFile(join(directory, template), text);
    f.snapshot.units[0]!.DropInPaths = join(directory, template);
    expect((await run(f.inputs)).status).toBe('satisfied');
    f.snapshot.units[0]!.DropInPaths = '';
    expect((await run(f.inputs)).status).toBe('unsatisfied');
  });
  it('checks templates through an inactive introspection instance and every observed instance', async () => {
    const f = await fixture();
    const base = 'kf-alert@.service';
    for (const directory of [f.shipped, f.installed])
      await writeFile(join(directory, base), '[Service]\nUser=kf-alert\nGroup=kf-alert\n');
    const probe = properties(
      'kf-alert@kf-commissioning-probe.service',
      'kf-alert',
      join(f.installed, base),
    );
    probe.OnFailure = '';
    f.snapshot.units.push(probe);
    expect((await run(f.inputs)).status).toBe('satisfied');
    const instance = {
      ...probe,
      Id: 'kf-alert@kf-api.service.service',
      Names: 'kf-alert@kf-api.service.service',
      User: 'root',
    };
    f.snapshot.units.push(instance);
    expect((await run(f.inputs)).status).toBe('unsatisfied');
  });
  it('does not disclose arbitrary template-instance identifiers in a refusal', async () => {
    const f = await fixture();
    const base = 'kf-alert@.service';
    for (const directory of [f.shipped, f.installed])
      await writeFile(join(directory, base), '[Service]\nUser=kf-alert\nGroup=kf-alert\n');
    const probe = properties(
      'kf-alert@kf-commissioning-probe.service',
      'kf-alert',
      join(f.installed, base),
    );
    probe.OnFailure = '';
    const name = 'kf-alert@PUBLIC_SECRET_SHAPED_INSTANCE.service';
    f.snapshot.units.push(probe, { ...probe, Id: name, Names: name, User: 'root' });
    const result = await run(f.inputs);
    expect(result.status).toBe('unsatisfied');
    expect(result.detail).toContain('kf-alert@.service instance: User');
    expect(JSON.stringify(result)).not.toContain('PUBLIC_SECRET_SHAPED_INSTANCE');
  });
});
