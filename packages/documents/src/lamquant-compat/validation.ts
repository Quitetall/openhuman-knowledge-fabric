import { isAbsolute, join } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import {
  FULL_COMMIT_SHA,
  LamQuantCompatibilityRejected,
  REQUIRED_TOOL_PATHS,
  SHA256,
  commandSucceeded,
  type LamQuantCommandRunner,
  type LamQuantCompatibilityFileSystem,
  type LamQuantCompatibilityOptions,
  type LamQuantManifestEntry,
  type LamQuantSourceIdentity,
} from './contracts.js';
import { lamQuantManifestIdentity } from './manifest.js';
import { processFailure } from './process-failure.js';
import { normalizeRelativePath } from './relative-paths.js';
import { requiredCodePaths } from './reference-inputs.js';

export function validateExpectedManifest(
  entries: readonly LamQuantManifestEntry[],
): readonly LamQuantManifestEntry[] {
  if (entries.length === 0) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      'LamQuant expected output manifest is empty',
    );
  }
  const seen = new Set<string>();
  const validated: LamQuantManifestEntry[] = [];
  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path, 'manifest path');
    if (!path.startsWith('docs/')) {
      throw new LamQuantCompatibilityRejected(
        'invalid_manifest',
        `LamQuant output manifest path must be under docs/, got '${path}'`,
      );
    }
    if (!SHA256.test(entry.sha256)) {
      throw new LamQuantCompatibilityRejected(
        'invalid_manifest',
        `LamQuant output manifest has an invalid SHA-256 for '${path}'`,
      );
    }
    const kind = entry.kind ?? 'file';
    if (kind !== 'file' && kind !== 'symlink') {
      throw new LamQuantCompatibilityRejected(
        'invalid_manifest',
        `LamQuant output manifest has an invalid kind for '${path}'`,
      );
    }
    if (kind === 'symlink') {
      validateManifestSymlinkTarget(entry.target ?? '', path);
    } else if (entry.target !== undefined) {
      throw new LamQuantCompatibilityRejected(
        'invalid_manifest',
        `LamQuant output manifest file '${path}' must not declare a symlink target`,
      );
    }
    if (seen.has(path)) {
      throw new LamQuantCompatibilityRejected(
        'invalid_manifest',
        `LamQuant output manifest repeats '${path}'`,
      );
    }
    seen.add(path);
    validated.push({
      path,
      sha256: entry.sha256,
      kind,
      ...(entry.target ? { target: entry.target } : {}),
    });
  }
  return validated.sort((left, right) => compareCanonicalText(left.path, right.path));
}

function validateManifestSymlinkTarget(target: string, path: string): void {
  if (target === '' || isAbsolute(target) || target.includes('\0') || target.includes('\\')) {
    throw new LamQuantCompatibilityRejected(
      'invalid_manifest',
      `LamQuant output manifest symlink '${path}' has an unsafe target`,
    );
  }
}

/**
 * The manifest identity for a manifest as a CALLER holds it.
 *
 * `lamQuantManifestIdentity` digests whatever it is given, and `validateCompatibilityOptions`
 * compares against the identity of the NORMALIZED manifest — normalization fills in `kind`,
 * so an entry written `{path, sha256}` digests differently from the `{path, sha256, kind}` the
 * validator ends up holding. A caller who digested their own raw entries therefore got
 * `invalid_manifest: does not bind the requested commit and manifest`, which describes the
 * symptom and not the cause.
 *
 * Composing the two steps here is the fix: there is now one way to compute the identity a
 * caller must supply, and it agrees with the validator by construction.
 */
export function lamQuantExpectedManifestIdentity(
  commitSha: string,
  entries: readonly LamQuantManifestEntry[],
): string {
  return lamQuantManifestIdentity(commitSha, validateExpectedManifest(entries));
}

export function validateCompatibilityOptions(
  options: LamQuantCompatibilityOptions,
): {
  readonly manifest: readonly LamQuantManifestEntry[];
  readonly expectedManifestDigest: string;
} {
  if (!FULL_COMMIT_SHA.test(options.commitSha)) {
    throw new LamQuantCompatibilityRejected(
      'unpinned',
      `LamQuant commit must be a full lowercase 40-character SHA, got '${options.commitSha}'`,
    );
  }
  if (!SHA256.test(options.expectedManifestDigest)) {
    throw new LamQuantCompatibilityRejected(
      'invalid_manifest',
      'LamQuant expected manifest identity must be a lowercase SHA-256',
    );
  }
  const manifest = validateExpectedManifest(options.expectedManifest);
  const expectedManifestDigest = lamQuantManifestIdentity(options.commitSha, manifest);
  if (expectedManifestDigest !== options.expectedManifestDigest) {
    throw new LamQuantCompatibilityRejected(
      'invalid_manifest',
      'LamQuant expected manifest identity does not bind the requested commit and manifest',
    );
  }
  return { manifest, expectedManifestDigest };
}

export async function inspectPinnedCheckout(
  options: LamQuantCompatibilityOptions,
  runner: LamQuantCommandRunner,
): Promise<LamQuantSourceIdentity> {
  const head = await runner.run({
    executable: 'git',
    args: ['rev-parse', '--verify', 'HEAD'],
    cwd: options.checkoutPath,
  });
  if (!commandSucceeded(head)) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant checkout '${options.checkoutPath}' has no readable HEAD (${processFailure(head)})`,
    );
  }
  if (head.stdout.trim() !== options.commitSha) {
    throw new LamQuantCompatibilityRejected(
      'unpinned',
      `LamQuant checkout HEAD does not match requested commit ${options.commitSha}`,
    );
  }

  const status = await runner.run({
    executable: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
    cwd: options.checkoutPath,
  });
  if (!commandSucceeded(status)) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant checkout '${options.checkoutPath}' cannot be inspected for dirt (${processFailure(status)})`,
    );
  }
  if (status.stdout !== '') {
    throw new LamQuantCompatibilityRejected(
      'dirty',
      `LamQuant checkout '${options.checkoutPath}' is dirty:\n${status.stdout}`,
    );
  }

  const submodulePins = await inspectSubmodulePins(options.checkoutPath, runner);
  return {
    rootCommitSha: options.commitSha,
    submodulePins,
    materialization: 'verified_clean_worktree',
  };
}

async function inspectSubmodulePins(
  checkoutPath: string,
  runner: LamQuantCommandRunner,
): Promise<readonly { readonly path: string; readonly commitSha: string }[]> {
  const submodules = await runner.run({
    executable: 'git',
    args: ['submodule', 'status', '--recursive'],
    cwd: checkoutPath,
  });
  if (!commandSucceeded(submodules)) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant submodule pins cannot be inspected (${processFailure(submodules)})`,
    );
  }
  return submodules.stdout
    .split('\n')
    .filter((item) => item !== '')
    .map(assertSubmoduleLine)
    .sort((left, right) => compareCanonicalText(left.path, right.path));
}

function assertSubmoduleLine(
  line: string,
): { readonly path: string; readonly commitSha: string } {
  if (line.startsWith('-')) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant has an uninitialized pinned submodule: ${line}`,
    );
  }
  if (line.startsWith('+')) {
    throw new LamQuantCompatibilityRejected(
      'unpinned',
      `LamQuant submodule checkout differs from its recorded pin: ${line}`,
    );
  }
  if (line.startsWith('U')) {
    throw new LamQuantCompatibilityRejected(
      'dirty',
      `LamQuant has a conflicted submodule: ${line}`,
    );
  }
  if (!line.startsWith(' ')) {
    throw new LamQuantCompatibilityRejected(
      'unpinned',
      `LamQuant returned an unrecognized submodule state: ${line}`,
    );
  }
  const match = /^ ([0-9a-f]{40}) ([^ ]+)(?: \(.*\))?$/.exec(line);
  if (match === null) {
    throw new LamQuantCompatibilityRejected(
      'unpinned',
      `LamQuant returned an unrecognized submodule identity: ${line}`,
    );
  }
  return { commitSha: match[1]!, path: match[2]! };
}

export async function assertRequiredInputs(
  checkoutPath: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  const docs = join(checkoutPath, 'docs');
  if ((await fileSystem.kind(docs)) !== 'directory') {
    throw new LamQuantCompatibilityRejected('missing_input', `LamQuant input '${docs}' is missing`);
  }
  for (const relativePath of REQUIRED_TOOL_PATHS) {
    const path = join(checkoutPath, relativePath);
    if ((await fileSystem.kind(path)) !== 'file') {
      throw new LamQuantCompatibilityRejected(
        'missing_input',
        `LamQuant required input '${relativePath}' is missing`,
      );
    }
  }
  const codePaths = await requiredCodePaths(checkoutPath, fileSystem);
  for (const relativePath of codePaths) {
    if ((await fileSystem.kind(join(checkoutPath, relativePath))) !== 'file') {
      throw new LamQuantCompatibilityRejected(
        'missing_input',
        `LamQuant required code-link input '${relativePath}' is missing`,
      );
    }
  }
  return codePaths;
}

export async function copyInputs(
  checkoutPath: string,
  scratchPath: string,
  codePaths: readonly string[],
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<void> {
  await fileSystem.copyDirectory(join(checkoutPath, 'docs'), join(scratchPath, 'docs'));
  if ((await fileSystem.kind(join(checkoutPath, 'decisions'))) === 'directory') {
    await fileSystem.copyDirectory(join(checkoutPath, 'decisions'), join(scratchPath, 'decisions'));
  }
  for (const relativePath of [...REQUIRED_TOOL_PATHS, ...codePaths]) {
    await fileSystem.copyFile(join(checkoutPath, relativePath), join(scratchPath, relativePath));
  }
}
