/** Linux native custody; values never enter the checker process or its environment. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function refuse(): never {
  throw new Error('native credential custody unavailable');
}

function protectedHelper(path: string): void {
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.uid !== 0 ||
    file.nlink !== 1 ||
    (file.mode & 0o7022) !== 0 ||
    (file.mode & 0o100) === 0
  )
    refuse();
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== 0 ||
      (directory.mode & 0o022) !== 0
    )
      refuse();
    if (parent === dirname(parent)) break;
  }
}

function releaseHelper(): string {
  // pnpm deploy nests dependencies differently for each consumer. Start at this
  // module's physical location and use its enclosing release's fixed tools atom;
  // never trust an executable supplied through a caller environment or option.
  for (
    let parent = dirname(realpathSync(fileURLToPath(import.meta.url)));
    ;
    parent = dirname(parent)
  ) {
    const helper = join(parent, 'tools', 'kf-credential-custody');
    if (existsSync(helper)) {
      protectedHelper(helper);
      return helper;
    }
    if (parent === dirname(parent)) refuse();
  }
}

function protectedProcessMemory(): void {
  const swaps = readFileSync('/proc/swaps', 'utf8').trim();
  if (!/^Filename\s+Type\s+Size\s+Used\s+Priority$/.test(swaps)) refuse();
  const group = /^0::(\/[^\n]*)$/.exec(readFileSync('/proc/self/cgroup', 'utf8').trim());
  const path = group?.[1];
  if (
    path === undefined ||
    resolve(path) !== path ||
    readFileSync(`/sys/fs/cgroup${path}/memory.swap.max`, 'utf8').trim() !== '0'
  )
    refuse();
  const core = readFileSync('/proc/self/limits', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('Max core file size'));
  if (!/^Max core file size\s+0\s+0\s+bytes$/.test(core?.trim() ?? '')) refuse();
}

/** Verify the exact named file under the caller's native credential directory. */
export function verifyNativeSecret(path: string, env: NodeJS.ProcessEnv): void {
  const directory = env['CREDENTIALS_DIRECTORY'];
  if (
    process.platform !== 'linux' ||
    directory === undefined ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    realpathSync(directory) !== directory ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    dirname(path) !== directory ||
    realpathSync(path) !== path
  )
    refuse();
  // PID1's credential mount protects stored bytes, not the JavaScript string
  // after loading. Refuse swap/core exposure before anything enters memory.
  protectedProcessMemory();
  const result = spawnSync(releaseHelper(), [directory, basename(path)], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 5000,
    stdio: 'ignore',
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) refuse();
}
