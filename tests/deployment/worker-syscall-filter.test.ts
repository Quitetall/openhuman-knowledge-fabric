/**
 * The worker unit's `SystemCallFilter=` is the syscall floor under the Liminal sandbox.
 *
 * seccomp filters are inherited across fork and exec and can only be added to, so whatever
 * kf-worker.service denies, bubblewrap and the compiler it starts are denied too. Two checks:
 *
 *   STATIC   the unit, read as systemd reads it, allows @system-service and @mount, takes back
 *            the dangerous groups, re-admits only what bubblewrap was measured to need, and
 *            answers a denied call with EPERM on the native architecture only.
 *   RUNTIME  where `systemd-run --user` works (this workstation; not a bare CI container), a
 *            real bubblewrap sandbox runs under EXACTLY the unit's lines: bubblewrap still
 *            builds it, and inside it ptrace — which a CONTROL run without the lines shows
 *            succeeding — is refused. That is the inheritance, observed rather than asserted.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const UNIT = readFileSync(join(ROOT, 'deploy', 'systemd', 'kf-worker.service'), 'utf8');

/** Every value of `key` in the [Service] section, in order, comments dropped. */
function serviceValues(key: string): string[] {
  const values: string[] = [];
  let inService = false;
  for (const raw of UNIT.replace(/\\\n/g, ' ').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inService = line === '[Service]';
    if (!inService || line.startsWith('#') || !line.startsWith(`${key}=`)) continue;
    values.push(line.slice(key.length + 1).trim());
  }
  return values;
}

const FILTER = serviceValues('SystemCallFilter');

/** What systemd would allow and deny, at the level of the names written in the unit. */
function effective(lines: readonly string[]): { allowed: Set<string>; denied: Set<string> } {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const line of lines) {
    const deny = line.startsWith('~');
    for (const name of (deny ? line.slice(1) : line).split(/\s+/).filter(Boolean)) {
      if (deny) {
        denied.add(name);
        allowed.delete(name);
      } else {
        allowed.add(name);
        denied.delete(name);
      }
    }
  }
  return { allowed, denied };
}

describe('kf-worker.service syscall filter', () => {
  it('is an allow list of the service and mount groups, with the dangerous groups taken back', () => {
    expect(FILTER[0]).toBe('@system-service @mount');
    const { allowed, denied } = effective(FILTER);
    for (const group of [
      '@privileged',
      '@debug',
      '@module',
      '@raw-io',
      '@reboot',
      '@swap',
      '@clock',
      '@cpu-emulation',
      '@obsolete',
      '@keyring',
    ]) {
      expect(denied, group).toContain(group);
      expect(allowed, group).not.toContain(group);
    }
    for (const call of ['userfaultfd', 'kcmp', 'process_vm_readv', 'process_vm_writev']) {
      expect(denied, call).toContain(call);
    }
    // The ONLY calls re-admitted after the deny line are the two bubblewrap was measured to
    // need. A third one here is a widening that must come with its own measurement.
    const readmitted = FILTER.slice(FILTER.findIndex((line) => line.startsWith('~')) + 1)
      .filter((line) => !line.startsWith('~'))
      .flatMap((line) => line.split(/\s+/));
    expect(readmitted.sort()).toEqual(['capset', 'pivot_root']);
    expect(serviceValues('SystemCallErrorNumber')).toEqual(['EPERM']);
    expect(serviceValues('SystemCallArchitectures')).toEqual(['native']);
    expect(serviceValues('NoNewPrivileges')).toEqual(['true']);
  });

  const BWRAP = '/usr/bin/bwrap';
  const PYTHON = '/usr/bin/python3';
  const userSystemd =
    process.platform === 'linux' &&
    existsSync(BWRAP) &&
    existsSync(PYTHON) &&
    process.arch === 'x64' &&
    spawnSync('systemd-run', ['--user', '--wait', '--pipe', '--quiet', '/usr/bin/true'], {
      timeout: 30_000,
    }).status === 0;

  describe.runIf(userSystemd)('a real sandbox under exactly these lines', () => {
    let root = '';
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'kf-unit-filter-'));
      await writeFile(
        join(root, 'probe.py'),
        [
          'import ctypes',
          'libc = ctypes.CDLL(None, use_errno=True)',
          'ctypes.set_errno(0)',
          // ptrace(PTRACE_TRACEME) on x86_64 (101): succeeds for any process nobody traces.
          'result = libc.syscall(ctypes.c_long(101), ctypes.c_long(0), ctypes.c_long(0), ctypes.c_long(0), ctypes.c_long(0))',
          'print(result, ctypes.get_errno())',
        ].join('\n'),
      );
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const sandbox = () => [
      BWRAP,
      '--unshare-all',
      '--unshare-user',
      '--disable-userns',
      '--die-with-parent',
      '--new-session',
      '--size',
      String(64 * 1024 * 1024),
      '--tmpfs',
      '/',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--symlink',
      'usr/bin',
      '/bin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--ro-bind',
      join(root, 'probe.py'),
      '/probe.py',
      '--',
      PYTHON,
      '/probe.py',
    ];

    const run = (properties: readonly string[]) =>
      spawnSync(
        'systemd-run',
        [
          '--user',
          '--wait',
          '--pipe',
          '--quiet',
          ...properties.flatMap((property) => ['-p', property]),
          ...sandbox(),
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );

    it('lets bubblewrap build the sandbox, and refuses inside it what the control allows', () => {
      const control = run(['NoNewPrivileges=yes']);
      expect(control.status, control.stderr).toBe(0);
      expect(control.stdout.trim()).toBe('0 0');

      const filtered = run([
        'NoNewPrivileges=yes',
        ...FILTER.map((line) => `SystemCallFilter=${line}`),
        ...serviceValues('SystemCallErrorNumber').map((v) => `SystemCallErrorNumber=${v}`),
        ...serviceValues('SystemCallArchitectures').map((v) => `SystemCallArchitectures=${v}`),
      ]);
      // bubblewrap got far enough to exec the probe: the filter admits what it needs.
      expect(filtered.status, filtered.stderr).toBe(0);
      // …and the probe, bubblewrap's grandchild, inherited the filter: EPERM (1).
      expect(filtered.stdout.trim()).toBe('-1 1');
    });
  });
});
