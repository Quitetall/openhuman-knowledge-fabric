/** Pinned canonical-JSON process adapter for the Liminal document compiler. */

import type { CompilationRequest, CompilerResponse, DocumentCompilerAdapter } from './compiler.js';
import { closeVerifiedExecutable, verifyLiminalExecutable } from './liminal-adapter/executable.js';
import { performLiminalPreflight } from './liminal-adapter/preflight.js';
import {
  resolveLiminalProcessConfig,
  type LiminalProcessConfig,
} from './liminal-adapter/options.js';
import { runLiminalCompiler } from './liminal-adapter/compiler-io.js';
import type {
  LiminalHostPreflightOptions,
  PinnedLiminalProcessOptions,
} from './liminal-adapter/contracts.js';
import { closeRuntimeFiles, openRuntimeFiles } from './liminal-adapter/runtime-files.js';
export { digestLiminalRuntimeClosure } from './liminal-adapter/identity.js';
export type { LiminalHostPreflightOptions, PinnedLiminalProcessOptions };

/**
 * Executes only the exact binary and Cargo.lock identities pinned in Compilation Basis.
 *
 * The verified binary runs in a fresh bubblewrap user/mount/PID/network namespace. Only the
 * captured executable, system runtime libraries, a private /proc, /dev and empty scratch
 * directories are visible; worker source, credentials and ambient host paths are never bound.
 */
export class PinnedLiminalProcessAdapter implements DocumentCompilerAdapter {
  readonly identity: LiminalProcessConfig['identity'];
  readonly #config: LiminalProcessConfig;
  #preflightPromise: Promise<void> | undefined;

  constructor(options: PinnedLiminalProcessOptions) {
    this.#config = resolveLiminalProcessConfig(options);
    this.identity = this.#config.identity;
  }

  /** Fail startup before jobs are accepted when the host sandbox contract is absent. */
  async preflight(): Promise<void> {
    this.#preflightPromise ??= performLiminalPreflight(this.#config);
    await this.#preflightPromise;
  }

  async compile(request: CompilationRequest): Promise<CompilerResponse> {
    // The exported adapter is safe even when a caller forgets the startup probe: no compiler
    // bytes execute until this exact adapter instance has passed its cached host preflight.
    await this.preflight();
    const executable = await verifyLiminalExecutable(this.#config);
    let runtimeFiles: Awaited<ReturnType<typeof openRuntimeFiles>>;
    try {
      runtimeFiles = await openRuntimeFiles(this.#config);
    } catch (error: unknown) {
      await closeVerifiedExecutable(executable);
      throw error;
    }
    try {
      await this.#config.afterPinVerification?.();
      return await this.#compileVerified(executable.bytes, runtimeFiles, request);
    } finally {
      await Promise.all([closeVerifiedExecutable(executable), closeRuntimeFiles(runtimeFiles)]);
    }
  }

  async #compileVerified(
    executable: Buffer,
    runtimeFiles: Awaited<ReturnType<typeof openRuntimeFiles>>,
    request: CompilationRequest,
  ): Promise<CompilerResponse> {
    return await runLiminalCompiler(this.#config, executable, runtimeFiles, request);
  }
}

/** Production startup probe independent of any caller-supplied compiler request. */
export async function preflightLiminalProcessHost(
  options: LiminalHostPreflightOptions,
): Promise<void> {
  const adapter = new PinnedLiminalProcessAdapter({
    ...options,
    identity: {
      kind: 'liminal',
      name: 'host-preflight-only',
      version: '0',
      protocol: 'kf-document-v1',
      commitSha: '0'.repeat(40),
      cargoLockDigest: options.cargoLockDigest,
      executableDigest: options.executableDigest,
      runtimeClosureDigest: options.runtimeClosureDigest,
      qualification: { state: 'not_run', receiptDigest: null, ratified: false },
    },
  });
  await adapter.preflight();
}
