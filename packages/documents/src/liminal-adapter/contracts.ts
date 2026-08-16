import type { FileHandle } from 'node:fs/promises';
import type { LiminalCompilerIdentity } from '../compiler.js';

export interface PinnedLiminalProcessOptions {
  readonly executablePath: string;
  readonly cargoLockPath: string;
  readonly identity: LiminalCompilerIdentity;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxDiagnosticBytes?: number;
  readonly pathEnvironment?: string;
  /** Absolute path to the host-qualified bubblewrap executable. */
  readonly bubblewrapPath: string;
  /**
   * Exact native loader/shared-library files exposed to the compiler sandbox.
   * Production entries are restricted to system library roots; directories are never accepted.
   */
  readonly runtimeFilePaths: readonly string[];
  /** Hard upper bound after SIGKILL before the invocation rejects independently of pipe close. */
  readonly cleanupTimeoutMs?: number;
  /**
   * Deadline for the host sandbox probe: bubblewrap spawn, one line of protocol, exit.
   *
   * Separate from `timeoutMs`, which bounds an actual compilation. This one bounds a
   * capability check that takes milliseconds on an idle host and was measured at 3.5-5.3s on
   * a busy one — so the value is a statement about how loaded a host may be before the fabric
   * refuses to compile, not about how long a document takes.
   */
  readonly preflightTimeoutMs?: number;
  /** Test fixtures only. Production execution requires a native Linux ELF binary. */
  readonly allowScriptExecutableForTests?: boolean;
  /** Test synchronization only; production callers have no reason to set this. */
  readonly afterPinVerification?: () => void | Promise<void>;
}

export type LiminalHostPreflightOptions = Pick<
  PinnedLiminalProcessOptions,
  | 'executablePath'
  | 'cargoLockPath'
  | 'bubblewrapPath'
  | 'runtimeFilePaths'
  | 'pathEnvironment'
  | 'cleanupTimeoutMs'
  | 'preflightTimeoutMs'
> & {
  readonly executableDigest: string;
  readonly cargoLockDigest: string;
  readonly runtimeClosureDigest: string;
};

export interface VerifiedExecutable {
  readonly bytes: Buffer;
}

export interface VerifiedRuntimeFile {
  readonly path: string;
  readonly file: FileHandle;
  readonly contentDigest: string;
}
