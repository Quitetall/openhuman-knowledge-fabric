import { dirname, join } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import {
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

  // Materialize EVERY pinned submodule, not an allowlist derived from
  // CODE_PREFIXES.
  //
  // Two measured defects motivated this, both found the first time the oracle
  // was pointed at LamQuant rather than at fixtures:
  //
  //  1. The old loop did `pinsByPath.get(path)` — an EXACT match — over roots
  //     taken from CODE_PREFIXES, then `continue`d. CODE_PREFIXES names paths
  //     *inside* submodules ('codec-neural/lamquant_neural'); pins are keyed by
  //     submodule roots ('codec-neural'). At LamQuant 551d3c50, 0 of 3 roots
  //     matched any of 12 pins, so the loop materialized NOTHING, every time.
  //     Not a false green — `assertRequiredInputs` still rejected downstream —
  //     but it reported a missing FILE, sending a reader after a deletion that
  //     never happened instead of a clone that never ran.
  //
  //  2. Fixing the match was not enough. CODE_PREFIXES lists three roots, while
  //     LamQuant's atoms also cite `codec-lossless/...` and
  //     `evaluation/openecs/...`. Those files exist; they were simply never
  //     cloned, so LamQuant's own doc gate failed inside scratch on three
  //     `links.code does not resolve` errors that are false in the real tree.
  //
  // An allowlist of roots is the wrong mechanism for this: it is a second place
  // to remember something, it was already wrong twice, and the impending
  // 13-repo collapse would invalidate it again. Every pin is cloned `--shared
  // --no-checkout`, so the cost is a checkout rather than an object copy, and
  // there is no list left to drift. CODE_PREFIXES keeps its real job —
  // expanding 'N/'-style reference shorthand — and stops deciding what exists.
  for (const { path, commitSha } of pins) {
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
