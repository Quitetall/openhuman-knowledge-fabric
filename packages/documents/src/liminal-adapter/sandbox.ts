import { dirname } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import type { LiminalProcessConfig } from './options.js';

/**
 * The full command for one sandboxed compiler run: `prlimit` applying the rlimits, exec'ing
 * bubblewrap, exec'ing the compiler. Limits set on the outermost process are inherited through
 * both execs and every fork inside, so nothing in the sandbox can raise them past the hard
 * value — prlimit sets soft and hard together, and an unprivileged process cannot raise a hard
 * limit. See `limits.ts` for why each limit is the one it is.
 */
export function sandboxCommand(
  config: LiminalProcessConfig,
  arguments_: readonly string[],
): { readonly command: string; readonly argv: string[] } {
  return {
    command: config.prlimitPath,
    argv: [
      `--data=${String(config.maxDataBytes)}`,
      `--fsize=${String(config.maxFileBytes)}`,
      `--nofile=${String(config.maxOpenFiles)}`,
      '--core=0',
      '--',
      config.bubblewrapPath,
      ...sandboxArguments(
        config.runtimeFilePaths,
        config.pathEnvironment,
        arguments_,
        config.sandboxTmpfsBytes,
      ),
    ],
  };
}

export function sandboxArguments(
  runtimeFilePaths: readonly string[],
  pathEnvironment: string,
  arguments_: readonly string[],
  tmpfsBytes: number,
): string[] {
  const directories = new Set(['/tmp', '/run', '/work']);
  for (const runtimePath of runtimeFilePaths) {
    let parent = dirname(runtimePath);
    while (parent !== '/') {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const directoryArguments = [...directories]
    .sort(
      (left, right) =>
        left.split('/').length - right.split('/').length || compareCanonicalText(left, right),
    )
    .flatMap((path) => ['--dir', path]);
  const runtimeArguments = runtimeFilePaths.flatMap((path, index) => [
    '--ro-bind-fd',
    String(index + 4),
    path,
  ]);
  return [
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--die-with-parent',
    '--new-session',
    // Bounded: an unsized tmpfs root is backed by the worker's memory with no ceiling.
    '--size',
    String(tmpfsBytes),
    '--tmpfs',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    ...directoryArguments,
    ...runtimeArguments,
    '--perms',
    '0500',
    '--ro-bind-data',
    '3',
    '/compiler',
    '--chdir',
    '/work',
    '--clearenv',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'LC_ALL',
    'C.UTF-8',
    '--setenv',
    'PATH',
    pathEnvironment,
    '--',
    '/compiler',
    ...arguments_,
  ];
}
