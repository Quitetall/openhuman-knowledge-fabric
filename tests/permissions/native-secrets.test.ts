// Mocked trust/path refusals supplement, never replace, the real PID1 mount proof.
import type * as FileSystem from 'node:fs';
import type * as ChildProcess from 'node:child_process';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSecret,
  readSecretFile,
  SecretRejected,
} from '../../packages/operations/src/secrets.js';

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  exists: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof FileSystem>()),
  readFileSync: fixture.read,
  statSync: fixture.stat,
  lstatSync: fixture.lstat,
  realpathSync: fixture.realpath,
  existsSync: fixture.exists,
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawnSync: fixture.spawn,
}));

const ROOT = resolve(import.meta.dirname, '../..');
const HELPER = `${ROOT}/tools/kf-credential-custody`;
const DIRECTORY = '/run/credentials/kf-public-native.service';
const PATH = `${DIRECTORY}/database-url`;
const VALUE = 'postgresql://fixture:never-log-this@example.invalid/kf';
const ENV = {
  KF_SECRET_CUSTODY: 'systemd',
  CREDENTIALS_DIRECTORY: DIRECTORY,
  DATABASE_URL_FILE: PATH,
};
const RUNTIME: Record<string, string> = {
  '/proc/swaps': 'Filename\tType\tSize\tUsed\tPriority\n',
  '/proc/self/cgroup': '0::/system.slice/kf-public-native.service\n',
  '/sys/fs/cgroup/system.slice/kf-public-native.service/memory.swap.max': '0\n',
  '/proc/self/limits': 'Max core file size        0       0       bytes\n',
};
function metadata(file = false, mode = 0o755, uid = 0) {
  return {
    uid,
    mode,
    nlink: 1,
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
  };
}
function rejected(body: () => unknown) {
  let error: unknown;
  try {
    body();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SecretRejected);
  expect((error as SecretRejected).reason).toBe('custody_unavailable');
  expect((error as Error).message).not.toContain('never-log-this');
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture.read.mockImplementation((path: string) => RUNTIME[path] ?? `${VALUE}\n`);
  fixture.stat.mockReturnValue({ mode: 0o440 });
  fixture.realpath.mockImplementation((path: string) => path);
  fixture.exists.mockImplementation((path: string) => path === HELPER);
  fixture.lstat.mockImplementation((path: string) => metadata(path === HELPER));
  fixture.spawn.mockReturnValue({ status: 0, signal: null });
});

describe('explicit systemd secret adapter', () => {
  it('reads a native credential only after the fixed root-protected checker accepts', () => {
    expect(loadSecret('DATABASE_URL', ENV)).toBe(VALUE);
    expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith(HELPER, [DIRECTORY, 'database-url'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 5000,
      stdio: 'ignore',
    });
    expect(fixture.spawn.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.read.mock.invocationCallOrder[
        fixture.read.mock.calls.findIndex(([path]) => path === PATH)
      ]!,
    );
  });

  it('uses the supplied environment for direct path-valued secret readers too', () => {
    expect(readSecretFile(PATH, 'PRESERVATION_SIGNING_KEY_PATH', undefined, ENV)).toBe(VALUE);
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    ['/proc/swaps', RUNTIME['/proc/swaps'] + '/swap file 1 0 -2\n'],
    ['/proc/swaps', 'unverifiable\n'],
    ['/proc/self/cgroup', '1:memory:/legacy\n'],
    ['/proc/self/cgroup', '0::/system.slice/../outside\n'],
    ['/sys/fs/cgroup/system.slice/kf-public-native.service/memory.swap.max', 'max\n'],
    ['/proc/self/limits', 'Max core file size        1       1       bytes\n'],
    ['/proc/self/limits', 'unverifiable\n'],
  ])('refuses unsafe or unverifiable process-memory custody from %s', (path, value) => {
    fixture.read.mockImplementation((input: string) =>
      input === path ? value : (RUNTIME[input] ?? `${VALUE}\n`),
    );
    rejected(() => loadSecret('DATABASE_URL', ENV));
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.read.mock.calls.map(([input]) => input)).not.toContain(PATH);
  });

  it('keeps ordinary group-readable files refused despite a native-directory variable', () => {
    expect(() =>
      loadSecret('DATABASE_URL', { DATABASE_URL_FILE: PATH, CREDENTIALS_DIRECTORY: DIRECTORY }),
    ).toThrow(/chmod 600/);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'Systemd', 'file'])(
    'refuses unsupported custody %s before reading',
    (custody) => {
      fixture.stat.mockReturnValue({ mode: 0o400 });
      rejected(() => loadSecret('DATABASE_URL', { ...ENV, KF_SECRET_CUSTODY: custody }));
      expect(fixture.read).not.toHaveBeenCalled();
    },
  );

  it('does not fall back to inline development secrets in explicit native custody', () => {
    rejected(() =>
      loadSecret(
        'DATABASE_URL',
        { ...ENV, DATABASE_URL_FILE: undefined, DATABASE_URL: VALUE },
        { allowInline: true },
      ),
    );
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('does not let a mode override bypass the native adapter', () => {
    rejected(() => loadSecret('DATABASE_URL', ENV, { forbiddenMode: 0 }));
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '/run/credentials/../kf-public-native.service', 'relative'])(
    'refuses absent or noncanonical credential directory %s',
    (directory) => {
      rejected(() => loadSecret('DATABASE_URL', { ...ENV, CREDENTIALS_DIRECTORY: directory }));
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(fixture.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/etc/kf/database-url',
    `${DIRECTORY}/nested/database-url`,
    `${DIRECTORY}/../database-url`,
  ])('refuses an outside or aliased path %s', (path) => {
    rejected(() => loadSecret('DATABASE_URL', { ...ENV, DATABASE_URL_FILE: path }));
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('refuses a directory alias rather than trusting its resolved location', () => {
    fixture.realpath.mockReturnValue('/run/credentials/something-else.service');
    rejected(() => loadSecret('DATABASE_URL', ENV));
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('refuses a missing helper without using a caller-supplied executable', () => {
    fixture.exists.mockReturnValue(false);
    rejected(() =>
      loadSecret('DATABASE_URL', { ...ENV, KF_CREDENTIAL_CUSTODY_HELPER: '/usr/bin/true' }),
    );
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it.each(['owner', 'writable', 'symlink', 'hardlink', 'not-executable'])(
    'refuses helper trust defect %s',
    (defect) => {
      fixture.lstat.mockImplementation((path: string) =>
        path === HELPER
          ? {
              ...metadata(
                true,
                defect === 'writable' ? 0o775 : defect === 'not-executable' ? 0o644 : 0o755,
                defect === 'owner' ? 1000 : 0,
              ),
              nlink: defect === 'hardlink' ? 2 : 1,
              isSymbolicLink: () => defect === 'symlink',
            }
          : metadata(),
      );
      rejected(() => loadSecret('DATABASE_URL', ENV));
      expect(fixture.spawn).not.toHaveBeenCalled();
    },
  );

  it('refuses a writable ancestor even when the executable itself is root-protected', () => {
    fixture.lstat.mockImplementation((path: string) =>
      metadata(path === HELPER, path === ROOT ? 0o775 : 0o755),
    );
    rejected(() => loadSecret('DATABASE_URL', ENV));
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it.each(['exit', 'signal', 'spawn-error'])(
    'refuses checker %s without logging child output or reading',
    (failure) => {
      fixture.spawn.mockReturnValue({
        status: failure === 'exit' ? 1 : 0,
        signal: failure === 'signal' ? 'SIGTERM' : null,
        error: failure === 'spawn-error' ? new Error(VALUE) : undefined,
        stderr: VALUE,
      });
      rejected(() => loadSecret('DATABASE_URL', ENV));
      expect(fixture.read.mock.calls.map(([input]) => input)).not.toContain(PATH);
    },
  );
});
