import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { compareCanonicalText, digest } from '@kf/canonicalization';
import type {
  LamQuantCompatibilityFileSystem,
  LamQuantManifestEntry,
  LamQuantManifestMismatch,
  LamQuantManifestParity,
} from './contracts.js';

export async function outputManifest(
  scratchPath: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly LamQuantManifestEntry[]> {
  const docs = join(scratchPath, 'docs');
  const entries: LamQuantManifestEntry[] = [];
  for (const relativePath of await fileSystem.listFiles(docs)) {
    const path = join(docs, relativePath);
    const kind = await fileSystem.kind(path);
    const target = kind === 'symlink' ? await fileSystem.readLink(path) : undefined;
    const bytes =
      kind === 'symlink' ? Buffer.from(target ?? '', 'utf8') : await fileSystem.readFile(path);
    entries.push({
      path: `docs/${relativePath}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      kind: kind === 'symlink' ? 'symlink' : 'file',
      ...(target === undefined ? {} : { target }),
    });
  }
  return entries.sort((left, right) => compareCanonicalText(left.path, right.path));
}

export function compareManifest(
  expected: readonly LamQuantManifestEntry[],
  actual: readonly LamQuantManifestEntry[],
): LamQuantManifestParity {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const missing = expected
    .filter((entry) => !actualByPath.has(entry.path))
    .map((entry) => entry.path);
  const unexpected = actual
    .filter((entry) => !expectedByPath.has(entry.path))
    .map((entry) => entry.path);
  const mismatched = expected.flatMap((entry): LamQuantManifestMismatch[] => {
    const actualEntry = actualByPath.get(entry.path);
    const expectedKind = entry.kind ?? 'file';
    return actualEntry !== undefined &&
      (actualEntry.sha256 !== entry.sha256 ||
        (actualEntry.kind ?? 'file') !== expectedKind ||
        actualEntry.target !== entry.target)
      ? [{ path: entry.path, expectedSha256: entry.sha256, actualSha256: actualEntry.sha256 }]
      : [];
  });
  return {
    matched: missing.length === 0 && unexpected.length === 0 && mismatched.length === 0,
    missing,
    unexpected,
    mismatched,
  };
}

export function manifestDigest(
  commitSha: string,
  expected: readonly LamQuantManifestEntry[],
  actual: readonly LamQuantManifestEntry[],
): string {
  return digest({ commitSha, expected, actual });
}

/** Immutable identity for a human-selected LamQuant golden corpus. */
export function lamQuantManifestIdentity(
  commitSha: string,
  manifest: readonly LamQuantManifestEntry[],
): string {
  return digest({ commitSha, manifest });
}
