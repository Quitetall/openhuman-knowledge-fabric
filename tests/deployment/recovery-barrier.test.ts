import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoveryBarrier } from '../../scripts/deploy/recovery-barrier.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kf-recovery-barrier-'));
  directories.push(root);
  const stateDirectory = join(root, 'state');
  const unitDirectory = join(root, 'units');
  mkdirSync(unitDirectory, { mode: 0o755 });
  const events: string[] = [];
  const states = new Map<string, string>();
  const options = {
    stateDirectory,
    unitDirectory,
    ownerUid: process.getuid!(),
    manager: (args: string[]) => {
      events.push(args.join(' '));
      if (args[0] === 'show') {
        const unit = args[1]!;
        return `LoadState=loaded\nActiveState=${states.get(unit) ?? 'inactive'}\nMainPID=0\nControlPID=0\nKillMode=control-group\n`;
      }
      if (args[0] === 'stop') {
        expect(existsSync(join(stateDirectory, 'held')), 'guard must precede stopping').toBe(true);
        for (const unit of args.slice(1)) states.set(unit, 'inactive');
      }
      return '';
    },
  };
  return { ...options, options, events, states };
}

describe('production recovery closes every declared permission-cache holder', () => {
  it('installs persistent start guards before stopping and keeps them held until confirmed recovery', () => {
    const f = fixture();
    recoveryBarrier('hold', ['lamu-retrieval.service'], f.options);
    for (const unit of ['kf-api.service', 'kf-worker.service', 'lamu-retrieval.service']) {
      expect(
        readFileSync(join(f.unitDirectory, `${unit}.d`, '90-kf-recovery.conf'), 'utf8'),
      ).toContain(`ExecStartPre=/usr/bin/test ! -e ${f.stateDirectory}/held`);
    }
    expect(f.events.indexOf('daemon-reload')).toBeLessThan(
      f.events.indexOf('stop kf-api.service kf-worker.service lamu-retrieval.service'),
    );
    expect(f.events.some((event) => event.startsWith('start '))).toBe(false);
    recoveryBarrier('resume-confirmed', [], f.options);
    expect(existsSync(join(f.stateDirectory, 'held'))).toBe(false);
    expect(f.events.at(-1)).toBe('start lamu-retrieval.service kf-worker.service kf-api.service');
  });

  it('refuses resume while even one cache holder still runs and retains the barrier', () => {
    const f = fixture();
    recoveryBarrier('hold', ['lamu-retrieval.service'], f.options);
    f.states.set('lamu-retrieval.service', 'active');
    expect(() => recoveryBarrier('resume-confirmed', [], f.options)).toThrow('not stopped');
    expect(existsSync(join(f.stateDirectory, 'held'))).toBe(true);
    expect(f.events.some((event) => event.startsWith('start '))).toBe(false);
  });

  it('leaves a persistent barrier on stop failure, and permits retry without forgetting holders', () => {
    const f = fixture();
    const manager = f.options.manager;
    f.options.manager = (args) => {
      if (args[0] === 'stop') throw new Error('stop failed');
      return manager(args);
    };
    expect(() => recoveryBarrier('hold', ['lamu-retrieval.service'], f.options)).toThrow(
      'stop failed',
    );
    expect(existsSync(join(f.stateDirectory, 'held'))).toBe(true);
    f.options.manager = manager;
    recoveryBarrier('hold', [], f.options);
    expect(f.events).toContain('stop kf-api.service kf-worker.service lamu-retrieval.service');
  });

  it('refuses unsafe names, a missing unit, or partial-cgroup stopping before recovery', () => {
    const f = fixture();
    for (const unit of ['../../other.service', '--all', 'x.timer', 'x.service\nother.service']) {
      expect(() => recoveryBarrier('hold', [unit], f.options)).toThrow();
    }
    f.options.manager = () => 'LoadState=not-found\n';
    expect(() => recoveryBarrier('hold', ['missing.service'], f.options)).toThrow('not loaded');
    expect(existsSync(join(f.stateDirectory, 'held'))).toBe(false);
    f.options.manager = () => 'LoadState=loaded\nKillMode=process\n';
    expect(() => recoveryBarrier('hold', [], f.options)).toThrow('control-group');
  });

  it('refuses symbolic-link state directories instead of creating a guard elsewhere', () => {
    const f = fixture();
    const outside = join(f.unitDirectory, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, f.stateDirectory);
    expect(() => recoveryBarrier('hold', [], f.options)).toThrow();
    expect(existsSync(join(outside, 'held'))).toBe(false);
  });

  it('refuses a changed guard and an expanded held list without resuming', () => {
    const f = fixture();
    recoveryBarrier('hold', ['lamu-retrieval.service'], f.options);
    expect(() => recoveryBarrier('hold', ['other.service'], f.options)).toThrow('cannot extend');
    chmodSync(join(f.unitDirectory, 'kf-api.service.d', '90-kf-recovery.conf'), 0o666);
    expect(() => recoveryBarrier('resume-confirmed', [], f.options)).toThrow('owner-controlled');
    expect(existsSync(join(f.stateDirectory, 'held'))).toBe(true);
    expect(f.events.some((event) => event.startsWith('start '))).toBe(false);
  });

  it('bounds the total holder set so its saved list can always be reread', () => {
    const f = fixture();
    const names = Array.from({ length: 63 }, (_, index) => `cache-${index}.service`);
    expect(() => recoveryBarrier('hold', names, f.options)).toThrow('invalid recovery unit list');
    expect(existsSync(join(f.stateDirectory, 'held'))).toBe(false);
  });
});
