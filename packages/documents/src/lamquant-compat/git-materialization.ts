import { dirname, join } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import {
  CODE_PREFIXES,
  LamQuantCompatibilityRejected,
  commandSucceeded,
  type LamQuantCommandResult,
  type LamQuantCommandRunner,
  type LamQuantCompatibilityFileSystem,
  type LamQuantCompatibilityOptions,
  type LamQuantSourceIdentity,
  type LamQuantSubmodulePin,
} from './contracts.js';
import { processFailure } from './process-failure.js';

/**
 * Build a disposable checkout from immutable local Git objects. Dirty working-tree bytes and
 * remote URLs are never read, and `--no-fetch` semantics are enforced by cloning only local
 * repositories whose requested objects were verified first.
 */
export async function materializeLamQuantGitObjects(
  options: LamQuantCompatibilityOptions,
  scratchPath: string,
  runner: LamQuantCommandRunner,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<LamQuantSourceIdentity> {
  await requireCommit(options.checkoutPath, options.commitSha, runner, 'LamQuant root');
  await requireSuccess(
    runner.run({
      executable: 'git',
      args: [
        'clone',
        '--shared',
        '--no-checkout',
        '--no-tags',
        '--',
        options.checkoutPath,
        scratchPath,
      ],
      cwd: dirname(scratchPath),
    }),
    'LamQuant root Git-object materialization failed',
  );
  await checkoutCommit(scratchPath, options.commitSha, runner, 'LamQuant root');

  const pins = await rootSubmodulePins(scratchPath, options.commitSha, runner);
  for (const pin of pins) {
    const sourcePath = join(options.checkoutPath, pin.path);
    if ((await fileSystem.kind(sourcePath)) !== 'directory') {
      throw new LamQuantCompatibilityRejected(
        'missing_input',
        `LamQuant pinned submodule '${pin.path}' is not initialized locally`,
      );
    }
    await requireCommit(sourcePath, pin.commitSha, runner, `LamQuant submodule '${pin.path}'`);
  }

  const requiredRoots = [...new Set(CODE_PREFIXES.map(([, path]) => path.replace(/\/$/, '')))].sort(
    compareCanonicalText,
  );
  const pinsByPath = new Map(pins.map((pin) => [pin.path, pin.commitSha]));
  for (const path of requiredRoots) {
    const commitSha = pinsByPath.get(path);
    if (commitSha === undefined) continue;
    const sourcePath = join(options.checkoutPath, path);
    const destinationPath = join(scratchPath, path);
    await fileSystem.makeDirectory(dirname(destinationPath));
    await requireSuccess(
      runner.run({
        executable: 'git',
        args: [
          'clone',
          '--shared',
          '--no-checkout',
          '--no-tags',
          '--',
          sourcePath,
          destinationPath,
        ],
        cwd: dirname(destinationPath),
      }),
      `LamQuant submodule '${path}' Git-object materialization failed`,
    );
    await checkoutCommit(destinationPath, commitSha, runner, `LamQuant submodule '${path}'`);
  }

  return {
    rootCommitSha: options.commitSha,
    submodulePins: pins,
    materialization: 'git_objects',
  };
}

async function rootSubmodulePins(
  checkoutPath: string,
  commitSha: string,
  runner: LamQuantCommandRunner,
): Promise<readonly LamQuantSubmodulePin[]> {
  const result = await runner.run({
    executable: 'git',
    args: ['ls-tree', '-r', '--full-tree', commitSha],
    cwd: checkoutPath,
  });
  if (!commandSucceeded(result)) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant submodule pins cannot be read (${processFailure(result)})`,
    );
  }
  return result.stdout
    .split('\n')
    .flatMap((line): LamQuantSubmodulePin[] => {
      const match = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line);
      return match === null ? [] : [{ commitSha: match[1]!, path: match[2]! }];
    })
    .sort((left, right) => compareCanonicalText(left.path, right.path));
}

async function requireCommit(
  repositoryPath: string,
  commitSha: string,
  runner: LamQuantCommandRunner,
  label: string,
): Promise<void> {
  const result = await runner.run({
    executable: 'git',
    args: ['cat-file', '-e', `${commitSha}^{commit}`],
    cwd: repositoryPath,
  });
  if (!commandSucceeded(result)) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `${label} does not contain pinned commit ${commitSha} (${processFailure(result)})`,
    );
  }
}

async function checkoutCommit(
  checkoutPath: string,
  commitSha: string,
  runner: LamQuantCommandRunner,
  label: string,
): Promise<void> {
  await requireSuccess(
    runner.run({
      executable: 'git',
      args: ['checkout', '--detach', '--force', commitSha],
      cwd: checkoutPath,
    }),
    `${label} checkout failed`,
  );
  const head = await runner.run({
    executable: 'git',
    args: ['rev-parse', '--verify', 'HEAD'],
    cwd: checkoutPath,
  });
  if (!commandSucceeded(head) || head.stdout.trim() !== commitSha) {
    throw new LamQuantCompatibilityRejected(
      'unpinned',
      `${label} did not materialize requested commit ${commitSha}`,
    );
  }
}

async function requireSuccess(
  result: Promise<LamQuantCommandResult>,
  message: string,
): Promise<void> {
  const resolved = await result;
  if (!commandSucceeded(resolved)) {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `${message} (${processFailure(resolved)})`,
    );
  }
}
