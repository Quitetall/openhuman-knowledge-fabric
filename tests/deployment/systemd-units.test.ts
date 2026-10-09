/**
 * Properties of the shipped systemd units that no single unit can be trusted to remember.
 *
 * Each block here pins a failure that was live in the shipped files: a crash loop that never
 * reached `failed` (so `OnFailure=` never fired), and similar. They read the unit files as
 * systemd does — by section — because a directive in the wrong section is silently ignored,
 * which is indistinguishable from the directive being absent until the night it matters.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const UNITS = join(ROOT, 'deploy', 'systemd');

type Sections = Map<string, Map<string, string[]>>;

/** Section -> key -> every value, in order. Comments and continuations handled as systemd does. */
function parseSections(text: string): Sections {
  const sections: Sections = new Map();
  let current: Map<string, string[]> | undefined;
  const lines = text.replace(/\\\n/g, ' ').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = sections.get(header[1]!) ?? new Map();
      sections.set(header[1]!, current);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0 || current === undefined) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    current.set(key, [...(current.get(key) ?? []), value]);
  }
  return sections;
}

function seconds(value: string): number {
  const match = /^(\d+)\s*(ms|s|sec|min|m|h)?$/.exec(value.trim());
  if (match === null) throw new Error(`unparseable systemd time span: ${value}`);
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return amount / 1000;
    case 'min':
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    default:
      return amount;
  }
}

function units(suffix: string): Array<{ name: string; sections: Sections }> {
  return readdirSync(UNITS)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => ({ name, sections: parseSections(readFileSync(join(UNITS, name), 'utf8')) }));
}

describe('a crash loop ends in failed, and failed reaches a person', () => {
  const restarting = units('.service').filter(
    (unit) => (unit.sections.get('Service')?.get('Restart') ?? ['no'])[0] !== 'no',
  );

  it('covers the long-running services (non-vacuous)', () => {
    expect(restarting.map((unit) => unit.name)).toEqual(
      expect.arrayContaining(['kf-api.service', 'kf-web.service', 'kf-worker.service']),
    );
  });

  it.each(restarting.map((unit) => [unit.name, unit.sections] as const))(
    '%s bounds its restarts in [Unit] and routes failure to an alert',
    (_name, sections) => {
      const unit = sections.get('Unit');
      const service = sections.get('Service');
      // [Unit], where systemd documents them. The [Service] spellings are compatibility
      // aliases with different names, and a misplaced directive is dropped with a log warning
      // nobody reads — leaving the loop unbounded again.
      const interval = unit?.get('StartLimitIntervalSec')?.[0];
      const burst = unit?.get('StartLimitBurst')?.[0];
      expect(interval, 'StartLimitIntervalSec= missing from [Unit]').toBeDefined();
      expect(burst, 'StartLimitBurst= missing from [Unit]').toBeDefined();
      expect(service?.get('StartLimitIntervalSec')).toBeUndefined();
      expect(unit?.get('OnFailure')?.[0]).toBe('kf-alert@%n.service');

      // A limit that can never trip is the original bug with extra lines. With restart delay
      // `r`, `burst` starts take at least `burst * r`, so the window must be longer than that.
      const restartDelay = seconds(service?.get('RestartSec')?.[0] ?? '100ms');
      expect(Number(burst)).toBeGreaterThan(0);
      expect(seconds(interval!)).toBeGreaterThan(Number(burst) * restartDelay);
      expect(seconds(interval!)).not.toBe(0);
    },
  );
});

describe('checkpoint signatures are verified daily, not only by the monthly drill', () => {
  const service = parseSections(readFileSync(join(UNITS, 'kf-audit-verify.service'), 'utf8'));
  const timer = parseSections(readFileSync(join(UNITS, 'kf-audit-verify.timer'), 'utf8'));

  it('runs the shipped verifier against the published public keys and alerts on a finding', () => {
    const exec = service.get('Service')?.get('ExecStart')?.[0] ?? '';
    expect(exec).toBe('/usr/bin/node /opt/kf/apps/checkpoint/dist/main.js --verify');
    const environment = service.get('Service')?.get('Environment') ?? [];
    expect(environment).toContain('CHECKPOINT_PUBLIC_KEY_DIR=/etc/kf/checkpoint-public-keys');
    expect(service.get('Unit')?.get('OnFailure')?.[0]).toBe('kf-alert@%n.service');
  });

  it('cannot sign: its own identity, and no signing key anywhere in the unit', () => {
    const user = service.get('Service')?.get('User')?.[0];
    expect(user).toBe('kf-audit-verify');
    const checkpoint = parseSections(readFileSync(join(UNITS, 'kf-checkpoint.service'), 'utf8'));
    expect(user).not.toBe(checkpoint.get('Service')?.get('User')?.[0]);
    expect(readFileSync(join(UNITS, 'kf-audit-verify.service'), 'utf8')).not.toContain(
      'CHECKPOINT_SIGNING_KEY',
    );
  });

  it('is scheduled at least daily and catches up after downtime', () => {
    const calendar = timer.get('Timer')?.get('OnCalendar')?.[0] ?? '';
    expect(calendar).toMatch(/^(daily|\*-\*-\* \d\d:\d\d:\d\d)$/);
    expect(timer.get('Timer')?.get('Persistent')?.[0]).toBe('true');
  });
});

describe('compilations are re-run on a schedule to test determinism (SAS §100.35)', () => {
  const service = parseSections(
    readFileSync(join(UNITS, 'kf-compiler-determinism.service'), 'utf8'),
  );
  const timer = parseSections(readFileSync(join(UNITS, 'kf-compiler-determinism.timer'), 'utf8'));
  const worker = parseSections(readFileSync(join(UNITS, 'kf-worker.service'), 'utf8'));

  it('runs the shipped re-run once and alerts on a finding', () => {
    expect(service.get('Service')?.get('Type')?.[0]).toBe('oneshot');
    const exec = service.get('Service')?.get('ExecStart')?.[0] ?? '';
    expect(exec).toMatch(/\/opt\/kf\/apps\/worker\/dist\/determinism-cli\.js --limit \d+$/);
    expect(readFileSync(join(ROOT, 'apps', 'worker', 'src', 'determinism-cli.ts'), 'utf8')).toMatch(
      /content\.compilation_determinism_sample/,
    );
    expect(service.get('Unit')?.get('OnFailure')?.[0]).toBe('kf-alert@%n.service');
  });

  it('compiles under the sandbox the worker compiles under', () => {
    // The Liminal child inherits the unit's seccomp filter and namespaces; a re-run under a
    // looser unit would test a compiler the worker never runs.
    for (const key of ['SystemCallFilter', 'RestrictNamespaces', 'EnvironmentFile', 'User']) {
      expect(service.get('Service')?.get(key), key).toEqual(worker.get('Service')?.get(key));
    }
  });

  it('is scheduled at least weekly and catches up after downtime', () => {
    expect(timer.get('Timer')?.get('OnCalendar')?.[0]).toMatch(
      /^(weekly|(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \*-\*-\* \d\d:\d\d:\d\d)$/,
    );
    expect(timer.get('Timer')?.get('Persistent')?.[0]).toBe('true');
  });
});

/**
 * KF-SAS-RQ-163: each service runs under a distinct unprivileged account, sharing one only where
 * two units require identical secrets and identical data.
 *
 * Nothing enforced it. `kf-backup` and `kf-restore-drill` shared a uid until 2026-09-23 on an
 * argument that turned out to be false (deploy/systemd/README.md tells that story), and the
 * only thing that noticed was a person reading both files. A unit with no `User=` runs as root,
 * silently; a copied unit that keeps its source's `User=` shares every secret that account can
 * read. Both are one-line edits, so both are pinned here.
 */
describe('every service runs as its own unprivileged account (KF-SAS-RQ-163)', () => {
  /**
   * The one sanctioned share, and why. Adding a row here is a claim that the units hold the
   * same secrets and the same data and nothing else — say which, or split the account.
   */
  const SHARED: ReadonlyMap<string, { units: readonly string[]; reason: string }> = new Map([
    [
      'kf-alert',
      {
        units: ['kf-alert-heartbeat.service', 'kf-alert@.service'],
        reason:
          'both hold exactly one secret, the alert webhook URL, and no data; the heartbeat ' +
          'exists to exercise the same delivery path the failure alert uses',
      },
    ],
    [
      'kf-worker',
      {
        units: ['kf-compiler-determinism.service', 'kf-worker.service'],
        reason:
          'the determinism re-run (SAS §100.35) compiles exactly as the worker does: the same ' +
          'database login, the same working-store credentials, the same pinned Liminal binary ' +
          'under the same sandbox; it holds nothing the worker does not, and records nothing',
      },
    ],
  ]);

  const services = units('.service').map((unit) => ({
    name: unit.name,
    users: unit.sections.get('Service')?.get('User') ?? [],
    dynamic: unit.sections.get('Service')?.get('DynamicUser') ?? [],
  }));

  it('reads the shipped services (non-vacuous)', () => {
    expect(services.length).toBeGreaterThanOrEqual(14);
  });

  it.each(services.map((unit) => [unit.name, unit] as const))(
    '%s names exactly one non-root User= in [Service]',
    (_name, unit) => {
      expect(unit.dynamic, 'DynamicUser= would make the account unpinnable').toEqual([]);
      expect(unit.users, 'no User= means the service runs as root').toHaveLength(1);
      const user = unit.users[0]!;
      expect(['root', '0', '']).not.toContain(user);
      expect(user, 'service accounts are named kf-*, so an operator can tell them apart').toMatch(
        /^kf-[a-z][a-z-]*$/,
      );
    },
  );

  it('no two services share an account unless the share is declared, and every declared share is real', () => {
    const byUser = new Map<string, string[]>();
    for (const unit of services) {
      const user = unit.users[0];
      if (user === undefined) continue;
      byUser.set(user, [...(byUser.get(user) ?? []), unit.name]);
    }
    const shared = [...byUser.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([user, names]) => ({ user, units: [...names].sort() }));
    const declared = [...SHARED.entries()].map(([user, entry]) => ({
      user,
      units: [...entry.units].sort(),
    }));
    // Equality, not containment: a declared share that no longer exists is a stale excuse
    // waiting to cover the next accidental one.
    expect(shared).toEqual(declared);
  });
});
