import { dirname } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';

export function sandboxArguments(
  runtimeFilePaths: readonly string[],
  pathEnvironment: string,
  arguments_: readonly string[],
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
