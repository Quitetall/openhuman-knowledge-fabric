/**
 * A stopped timer is noticed.
 *
 * Until 2026-09-23 nothing checked that the scheduled units were still being scheduled. A timer
 * that is stopped or never enabled fails nothing: its service does not run, `OnFailure=` never
 * fires, and the absence is visible only to someone who runs `systemctl list-timers`.
 * `scripts/timer-liveness.sh` asks systemd when each shipped timer last fired and fails when
 * one is inactive or silent longer than it declares. These run the real script against a fake
 * `systemctl`, and fail against a tree without it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const LIVENESS = join(ROOT, 'scripts', 'timer-liveness.sh');
const UNITS = join(ROOT, 'deploy', 'systemd');
const NOW = 1_790_000_000;
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TIMERS = readdirSync(UNITS)
  .filter((name) => name.startsWith('kf-') && name.endsWith('.timer'))
  .sort();

function declared(timer: string): number {
  const match = /^X-KF-MaxSilenceSec=(\d+)$/m.exec(readFileSync(join(UNITS, timer), 'utf8'));
  return match === null ? Number.NaN : Number(match[1]);
}

interface TimerState {
  readonly active?: boolean;
  readonly lastFired?: number | null;
  readonly activeSince?: number | null;
}

/** Run the script with systemd reporting `states` (default: every timer fired a minute ago). */
function liveness(states: Record<string, TimerState> = {}, args: string[] = []) {
  const bin = mkdtempSync(join(tmpdir(), 'kf-liveness-'));
  directories.push(bin);
  const table = TIMERS.map((timer) => {
    const state = states[timer] ?? {};
    const last = state.lastFired === undefined ? NOW - 60 : state.lastFired;
    const since = state.activeSince === undefined ? NOW - 86_400 * 60 : state.activeSince;
    return [
      timer,
      state.active === false ? 'inactive' : 'active',
      last === null ? '' : `@${last}`,
      since === null ? '' : `@${since}`,
    ].join('|');
  }).join('\n');
  writeFileSync(join(bin, 'state'), `${table}\n`);
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = show ] || exit 2
line="$(grep "^$2|" "${join(bin, 'state')}")" || { printf 'ActiveState=inactive\\nLastTriggerUSec=\\nActiveEnterTimestamp=\\n'; exit 0; }
IFS='|' read -r _ state last since <<< "$line"
printf 'ActiveState=%s\\nActiveEnterTimestamp=%s\\nLastTriggerUSec=%s\\n' "$state" "\${since:-}" "\${last:-}"
`,
    { mode: 0o755 },
  );
  const r = spawnSync('bash', [LIVENESS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, KF_NOW_EPOCH: String(NOW) },
  });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

describe('every shipped timer declares how long it may stay silent', () => {
  it.each(TIMERS)('%s', (timer) => {
    const limit = declared(timer);
    expect(limit, `${timer} declares no X-KF-MaxSilenceSec`).toBeGreaterThan(0);
    // Longer than its own schedule, or it would fail on a healthy host.
    const calendar = /^OnCalendar=(.+)$/m.exec(readFileSync(join(UNITS, timer), 'utf8'))![1]!;
    const period = calendar.includes('01..07')
      ? 35 * 86_400
      : calendar === 'hourly'
        ? 3600
        : calendar.startsWith('*:0/')
          ? Number(calendar.slice(4)) * 60
          : 86_400;
    expect(limit, `${timer} would report a healthy schedule as late`).toBeGreaterThan(period);
  });
});

describe('timer-liveness.sh', () => {
  it('passes when every timer fired within its interval', () => {
    const r = liveness();
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(`all ${TIMERS.length} timer(s) fired`);
  });

  it('fails, naming it, when a timer is stopped', () => {
    const r = liveness({ 'kf-backup.timer': { active: false } });
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAIL kf-backup.timer: inactive');
  });

  it('fails when a timer has been silent longer than it declares', () => {
    const r = liveness({
      'kf-checkpoint.timer': { lastFired: NOW - declared('kf-checkpoint.timer') - 1 },
    });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/FAIL kf-checkpoint\.timer: last fired \d+s ago/);
  });

  it('allows a newly enabled timer that is not yet due, and not one that never will be', () => {
    expect(
      liveness({ 'kf-restore-drill.timer': { lastFired: null, activeSince: NOW - 3600 } }).code,
    ).toBe(0);
    const never = liveness({
      'kf-restore-drill.timer': {
        lastFired: null,
        activeSince: NOW - declared('kf-restore-drill.timer') - 1,
      },
    });
    expect(never.code).toBe(1);
    expect(never.output).toContain('has never fired');
  });

  it('checks only the named timer when given one, as the heartbeat does', () => {
    const r = liveness({ 'kf-backup.timer': { active: false } }, ['kf-readiness.timer']);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('kf-readiness.timer');
    expect(r.output).not.toContain('kf-backup.timer');
  });
});

describe('the shipped units run it', () => {
  it('readiness checks every timer; the heartbeat is withheld while readiness is not firing', () => {
    const readiness = readFileSync(join(UNITS, 'kf-readiness.service'), 'utf8');
    const heartbeat = readFileSync(join(UNITS, 'kf-alert-heartbeat.service'), 'utf8');
    expect(readiness).toMatch(/^ExecStart=\/opt\/kf\/scripts\/timer-liveness\.sh$/m);
    expect(readiness).toMatch(/^OnFailure=kf-alert@%n\.service$/m);
    expect(heartbeat).toMatch(
      /^ExecStartPre=\/opt\/kf\/scripts\/timer-liveness\.sh kf-readiness\.timer$/m,
    );
  });
});
