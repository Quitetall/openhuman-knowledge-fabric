import { readFile } from 'node:fs/promises';
import { digestBytes } from '@kf/canonicalization';
import type { VerifiedExecutable } from './contracts.js';
import type { LiminalProcessConfig } from './options.js';

export async function verifyLiminalExecutable(
  config: LiminalProcessConfig,
): Promise<VerifiedExecutable> {
  if (process.platform !== 'linux') {
    throw new Error('Pinned Liminal execution requires Linux /proc file-descriptor support');
  }
  const [executableBytes, cargoLock] = await Promise.all([
    readFile(config.executablePath),
    readFile(config.cargoLockPath),
  ]);
  if (digestBytes(executableBytes) !== config.identity.executableDigest) {
    throw new Error('Liminal executable digest mismatch');
  }
  if (digestBytes(cargoLock) !== config.identity.cargoLockDigest) {
    throw new Error('Liminal Cargo.lock digest mismatch');
  }
  if (!config.allowScriptExecutableForTests && !isElf(executableBytes)) {
    throw new Error('Pinned Liminal production execution requires a native Linux ELF binary');
  }
  return { bytes: Buffer.from(executableBytes) };
}

export async function closeVerifiedExecutable(executable: VerifiedExecutable): Promise<void> {
  executable.bytes.fill(0);
}

function isElf(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  );
}
