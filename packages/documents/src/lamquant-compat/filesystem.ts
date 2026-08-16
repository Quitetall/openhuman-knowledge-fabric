import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LamQuantCompatibilityFileSystem, LamQuantPathKind } from './contracts.js';

async function pathKind(path: string): Promise<LamQuantPathKind> {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    if (stats.isSymbolicLink()) return 'symlink';
    return 'other';
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function copyDirectoryTree(
  source: string,
  destination: string,
  root = source,
): Promise<void> {
  if ((await pathKind(source)) !== 'directory') {
    throw new Error(`cannot copy non-directory '${source}'`);
  }
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryTree(sourcePath, destinationPath, root);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(sourcePath);
      assertSafeSymlinkTarget(root, sourcePath, target);
      await symlink(target, destinationPath);
    } else {
      throw new Error(`refusing to copy non-regular LamQuant input '${sourcePath}'`);
    }
  }
}

async function listRegularFiles(root: string): Promise<readonly string[]> {
  if ((await pathKind(root)) !== 'directory') {
    throw new Error(`cannot list non-directory '${root}'`);
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(root, path).split(sep).join('/'));
      } else {
        throw new Error(`refusing non-regular file in compatibility tree '${path}'`);
      }
    }
  }
  await walk(root);
  return files.sort();
}

export const nodeLamQuantCompatibilityFileSystem: LamQuantCompatibilityFileSystem = {
  kind: pathKind,
  makeScratchDirectory: async () => mkdtemp(join(tmpdir(), 'kf-lamquant-compat-')),
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  copyDirectory: copyDirectoryTree,
  copyFile: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  },
  listFiles: listRegularFiles,
  readFile,
  readLink: readlink,
  removeTree: async (path) => rm(path, { recursive: true, force: true }),
};

function assertSafeSymlinkTarget(root: string, linkPath: string, target: string): void {
  if (target === '' || isAbsolute(target) || target.includes('\0') || target.includes('\\')) {
    throw new Error(`refusing unsafe LamQuant symlink '${linkPath}' -> '${target}'`);
  }
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(dirname(linkPath), target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(
      `refusing LamQuant symlink that escapes copied tree '${linkPath}' -> '${target}'`,
    );
  }
}
