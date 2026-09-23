import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compilerSeccompProgram,
  currentSeccompArchitecture,
  SECCOMP_DENIED,
  seccompSyscallNumber,
  type SeccompArchitecture,
} from './liminal-adapter/seccomp.js';
import { sandboxArguments, seccompDescriptor } from './liminal-adapter/sandbox.js';

/**
 * The compiler's syscall filter, checked three ways: its numbers against libseccomp's own
 * tables, its wiring into the bubblewrap argv, and — the one that matters — a real process
 * under bubblewrap asking for denied syscalls and being refused, next to a CONTROL run without
 * the filter where the same calls succeed. Without the control, a probe that fails for some
 * other reason (no ptrace, no python) would read as a working filter.
 */

const RESOLVER = '/usr/bin/scmp_sys_resolver';
const BWRAP = process.env['KF_TEST_BWRAP_PATH'] ?? '/usr/bin/bwrap';
const PYTHON = '/usr/bin/python3';
const ARCH = currentSeccompArchitecture();

describe('the compiler syscall filter', () => {
  it.runIf(existsSync(RESOLVER))(
    'numbers every denied syscall as libseccomp does, on both architectures',
    () => {
      for (const arch of ['x86_64', 'aarch64'] as const satisfies readonly SeccompArchitecture[]) {
        for (const name of [...SECCOMP_DENIED, 'clone']) {
          const resolved = Number(
            execFileSync(RESOLVER, ['-a', arch, name], { encoding: 'utf8' }).trim(),
          );
          // libseccomp answers a negative pseudo-number for a call the arch does not have.
          const expected = resolved < 0 ? undefined : resolved;
          expect(seccompSyscallNumber(arch, name), `${arch} ${name}`).toBe(expected);
        }
      }
    },
  );

  it('is a whole number of sock_filter instructions ending in ALLOW, and refuses other arches', () => {
    for (const arch of ['x86_64', 'aarch64'] as const) {
      const program = compilerSeccompProgram(arch);
      expect(program.length % 8).toBe(0);
      expect(program.length / 8).toBeLessThan(256);
      expect(program.readUInt32LE(program.length - 4)).toBe(0x7fff0000);
    }
    expect(() => compilerSeccompProgram(undefined)).toThrow(/refusing to run the compiler/);
    expect(currentSeccompArchitecture()).toBe(
      process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined,
    );
  });

  it('is handed to bubblewrap on the descriptor after the runtime files', () => {
    const runtime = ['/usr/lib/a.so', '/usr/lib/b.so'];
    const argv = sandboxArguments(runtime, '/usr/bin', ['--protocol', 'p'], 1024);
    expect(seccompDescriptor(runtime)).toBe(6);
    expect(argv.slice(argv.indexOf('--seccomp'), argv.indexOf('--seccomp') + 2)).toEqual([
      '--seccomp',
      '6',
    ]);
    // Every runtime descriptor is below it, so the filter cannot shadow a runtime file.
    const bound = argv.flatMap((value, index) =>
      argv[index - 1] === '--ro-bind-fd' ? [value] : [],
    );
    expect(bound).toEqual(['4', '5']);
  });

  describe.runIf(
    process.platform === 'linux' && ARCH !== undefined && existsSync(BWRAP) && existsSync(PYTHON),
  )('under a real bubblewrap sandbox', () => {
    let root = '';
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'kf-seccomp-'));
      await writeFile(
        join(root, 'probe.py'),
        [
          'import ctypes, json, os, sys, threading',
          'libc = ctypes.CDLL(None, use_errno=True)',
          'def call(nr, *args):',
          '    ctypes.set_errno(0)',
          '    result = libc.syscall(ctypes.c_long(nr), *[a if isinstance(a, ctypes._SimpleCData) or not isinstance(a, int) else ctypes.c_long(a) for a in args])',
          '    return [result, ctypes.get_errno()]',
          'class Iov(ctypes.Structure):',
          '    _fields_ = [("base", ctypes.c_void_p), ("length", ctypes.c_size_t)]',
          'dst, src = ctypes.create_string_buffer(8), ctypes.create_string_buffer(b"abcdefgh")',
          'local = Iov(ctypes.cast(dst, ctypes.c_void_p), 8)',
          'remote = Iov(ctypes.cast(src, ctypes.c_void_p), 8)',
          'ptrace, readv = int(sys.argv[1]), int(sys.argv[2])',
          'out = {"ptrace": call(ptrace, 0, 0, 0, 0),',
          '       "readv": call(readv, os.getpid(), ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)}',
          't = threading.Thread(target=lambda: None); t.start(); t.join()',
          'out["thread"] = True',
          'print(json.dumps(out))',
        ].join('\n'),
      );
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('refuses ptrace and process_vm_readv that succeed without it, and leaves threads alone', async () => {
      const control = spawnSync(BWRAP, probeArgs(false), { encoding: 'utf8', timeout: 60_000 });
      expect(control.status, control.stderr).toBe(0);
      expect(JSON.parse(control.stdout)).toEqual({
        ptrace: [0, 0],
        readv: [8, 0],
        thread: true,
      });
      const filtered = await runFiltered();
      expect(filtered.status, filtered.stderr).toBe(0);
      expect(JSON.parse(filtered.stdout)).toEqual({
        ptrace: [-1, 1],
        readv: [-1, 1],
        thread: true,
      });
    });

    function probeArgs(filtered: boolean): string[] {
      return [
        ...(filtered ? ['--seccomp', '3'] : []),
        '--unshare-all',
        '--unshare-user',
        '--disable-userns',
        '--die-with-parent',
        '--new-session',
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
        String(seccompSyscallNumber(ARCH!, 'ptrace')),
        String(seccompSyscallNumber(ARCH!, 'process_vm_readv')),
      ];
    }

    /** The program goes in on a pipe at fd 3, the way the adapter hands it over. */
    function runFiltered(): Promise<{ status: number | null; stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(BWRAP, probeArgs(true), { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, stdout, stderr }));
        (child.stdio[3] as NodeJS.WritableStream).end(compilerSeccompProgram(ARCH));
      });
    }
  });
});
