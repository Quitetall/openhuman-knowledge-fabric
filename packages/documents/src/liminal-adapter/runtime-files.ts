import { open } from 'node:fs/promises';
import type { VerifiedRuntimeFile } from './contracts.js';
import { boundedRuntimeTotal, digestOpenFile, runtimeClosureDigest } from './identity.js';
import type { LiminalProcessConfig } from './options.js';

export async function openRuntimeFiles(
  config: LiminalProcessConfig,
): Promise<readonly VerifiedRuntimeFile[]> {
  const opened: VerifiedRuntimeFile[] = [];
  let totalBytes = 0;
  try {
    for (const path of config.runtimeFilePaths) {
      const file = await open(path, 'r');
      try {
        const runtimeStat = await file.stat();
        if (!runtimeStat.isFile()) {
          throw new Error('every runtimeFilePaths entry must name a regular file');
        }
        if ((runtimeStat.mode & 0o022) !== 0) {
          throw new Error('runtimeFilePaths entries must not be group- or world-writable');
        }
        if (!config.allowScriptExecutableForTests && runtimeStat.uid !== 0) {
          throw new Error('production runtimeFilePaths entries must be owned by root');
        }
        totalBytes = boundedRuntimeTotal(path, runtimeStat.size, totalBytes);
        opened.push({
          path,
          file,
          contentDigest: await digestOpenFile(file, runtimeStat.size),
        });
      } catch (error: unknown) {
        await file.close().catch(() => undefined);
        throw error;
      }
    }
    if (runtimeClosureDigest(opened) !== config.identity.runtimeClosureDigest) {
      throw new Error('Liminal runtime closure digest mismatch');
    }
    return opened;
  } catch (error: unknown) {
    await Promise.all(opened.map(async ({ file }) => file.close().catch(() => undefined)));
    throw error;
  }
}

export async function closeRuntimeFiles(files: readonly VerifiedRuntimeFile[]): Promise<void> {
  await Promise.all(files.map(async ({ file }) => file.close()));
}
