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
