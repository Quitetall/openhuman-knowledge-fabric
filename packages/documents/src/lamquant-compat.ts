/**
 * Read-only LamQuant documentation compatibility oracle.
 *
 * Production materializes immutable local Git objects. LamQuant's mutating document builders
 * run only against disposable scratch bytes, so live worktree bytes cannot rewrite the oracle.
 */

import {
  LamQuantCompatibilityRejected,
  commandSucceeded,
  type LamQuantCompatibilityDependencies,
  type LamQuantCompatibilityOptions,
  type LamQuantCompatibilityReport,
  type LamQuantSourceIdentity,
} from './lamquant-compat/contracts.js';
import { nodeLamQuantCompatibilityFileSystem } from './lamquant-compat/filesystem.js';
import { runGates } from './lamquant-compat/gates.js';
import { materializeLamQuantGitObjects } from './lamquant-compat/git-materialization.js';
import {
  compareManifest,
  lamQuantManifestIdentity,
  manifestDigest,
  outputManifest,
} from './lamquant-compat/manifest.js';
import { nodeLamQuantCommandRunner } from './lamquant-compat/process-runner.js';
import { compareSemanticProjection } from './lamquant-compat/semantic-compare.js';
import { buildGeneratedSemanticProjection } from './lamquant-compat/semantic-generated.js';
import { buildSourceSemanticProjection } from './lamquant-compat/semantic-projection.js';
import {
  assertRequiredInputs,
  copyInputs,
  inspectPinnedCheckout,
  validateCompatibilityOptions,
} from './lamquant-compat/validation.js';

export type {
  LamQuantCommandRequest,
  LamQuantCommandResult,
  LamQuantCommandRunner,
  LamQuantCommandRunnerFailure,
  LamQuantCompatibilityDependencies,
  LamQuantCompatibilityFileSystem,
  LamQuantCompatibilityOptions,
  LamQuantCompatibilityRejectionReason,
  LamQuantCompatibilityReport,
  LamQuantGateEvidence,
  LamQuantGateName,
  LamQuantManifestEntry,
  LamQuantManifestMismatch,
  LamQuantManifestParity,
  LamQuantNamedDigest,
  LamQuantPathKind,
  LamQuantSourceIdentity,
  LamQuantSubmodulePin,
  LamQuantSemanticDimension,
  LamQuantSemanticEvidence,
  LamQuantSemanticMismatch,
  LamQuantSemanticProjection,
  NodeLamQuantCommandRunnerOptions,
} from './lamquant-compat/contracts.js';
export { LamQuantCompatibilityRejected };
export {
  createNodeLamQuantCommandRunner,
  nodeLamQuantCommandRunner,
} from './lamquant-compat/process-runner.js';
export { nodeLamQuantCompatibilityFileSystem } from './lamquant-compat/filesystem.js';
export { lamQuantManifestIdentity } from './lamquant-compat/manifest.js';

const NODE_DEPENDENCIES: LamQuantCompatibilityDependencies = {
  commandRunner: nodeLamQuantCommandRunner,
  fileSystem: nodeLamQuantCompatibilityFileSystem,
  materializeCheckout: materializeLamQuantGitObjects,
};

/**
 * Run LamQuant's documentation compiler in disposable scratch and compare every resulting
 * `docs/` byte against an independently supplied SHA-256 manifest.
 */
export async function runLamQuantCompatibilityOracle(
  options: LamQuantCompatibilityOptions,
  dependencies: LamQuantCompatibilityDependencies = NODE_DEPENDENCIES,
): Promise<LamQuantCompatibilityReport> {
  const { manifest: expectedManifest, expectedManifestDigest } =
    validateCompatibilityOptions(options);
  if ((await dependencies.fileSystem.kind(options.checkoutPath)) !== 'directory') {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant checkout '${options.checkoutPath}' is not a directory`,
    );
  }
  const legacySource =
    dependencies.materializeCheckout === undefined
      ? {
          identity: await inspectPinnedCheckout(options, dependencies.commandRunner),
          codePaths: await assertRequiredInputs(options.checkoutPath, dependencies.fileSystem),
          compatibility: await buildSourceSemanticProjection(
            options.checkoutPath,
            dependencies.fileSystem,
          ),
        }
      : undefined;
  const scratchPath = await dependencies.fileSystem.makeScratchDirectory();
  try {
    let sourceIdentity: LamQuantSourceIdentity;
    if (dependencies.materializeCheckout !== undefined) {
      sourceIdentity = await dependencies.materializeCheckout(
        options,
        scratchPath,
        dependencies.commandRunner,
        dependencies.fileSystem,
      );
    } else {
      sourceIdentity = legacySource!.identity;
      await copyInputs(
        options.checkoutPath,
        scratchPath,
        legacySource!.codePaths,
        dependencies.fileSystem,
      );
    }
    await assertRequiredInputs(scratchPath, dependencies.fileSystem);
    const sourceCompatibility =
      legacySource?.compatibility ??
      (await buildSourceSemanticProjection(scratchPath, dependencies.fileSystem));
    const gates = await runGates(
      scratchPath,
      options.pythonExecutable ?? 'python3',
      dependencies.commandRunner,
    );
    const manifest = await outputManifest(scratchPath, dependencies.fileSystem);
    const parity = compareManifest(expectedManifest, manifest);
    const generatedCompatibility = await buildGeneratedSemanticProjection(
      scratchPath,
      dependencies.fileSystem,
    );
    const compatibility = compareSemanticProjection(sourceCompatibility, generatedCompatibility);
    return {
      commitSha: options.commitSha,
      sourceIdentity,
      expectedManifestDigest,
      generatedManifestDigest: lamQuantManifestIdentity(options.commitSha, manifest),
      manifestDigest: manifestDigest(options.commitSha, expectedManifest, manifest),
      passed: gates.every(commandSucceeded) && parity.matched && compatibility.matched,
      gates,
      manifest,
      parity,
      compatibility,
    };
  } finally {
    await dependencies.fileSystem.removeTree(scratchPath);
  }
}
