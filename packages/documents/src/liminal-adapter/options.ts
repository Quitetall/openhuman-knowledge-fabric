import { isAbsolute, normalize } from 'node:path';
import type { LiminalCompilerIdentity } from '../compiler.js';
import type { PinnedLiminalProcessOptions } from './contracts.js';
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_DIAGNOSTIC_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_OPEN_FILES,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  DEFAULT_PRLIMIT_PATH,
  DEFAULT_SANDBOX_TMPFS_BYTES,
  DEFAULT_TIMEOUT_MS,
  positiveLimit,
} from './limits.js';

export interface LiminalProcessConfig {
  readonly executablePath: string;
  readonly cargoLockPath: string;
  readonly identity: LiminalCompilerIdentity;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly cleanupTimeoutMs: number;
  readonly preflightTimeoutMs: number;
  readonly pathEnvironment: string;
  readonly bubblewrapPath: string;
  readonly prlimitPath: string;
  readonly sandboxTmpfsBytes: number;
  readonly maxDataBytes: number;
  readonly maxFileBytes: number;
  readonly maxOpenFiles: number;
  readonly runtimeFilePaths: readonly string[];
  readonly allowScriptExecutableForTests: boolean;
  readonly afterPinVerification: (() => void | Promise<void>) | undefined;
}

export function resolveLiminalProcessConfig(
  options: PinnedLiminalProcessOptions,
): LiminalProcessConfig {
  if (options.identity.kind !== 'liminal' || options.identity.protocol !== 'kf-document-v1') {
    throw new Error('Liminal adapter requires a kf-document-v1 Liminal identity');
  }
  if (options.allowScriptExecutableForTests === true && process.env['NODE_ENV'] !== 'test') {
    throw new Error('allowScriptExecutableForTests is only available when NODE_ENV=test');
  }
  if (typeof options.bubblewrapPath !== 'string' || !isAbsolute(options.bubblewrapPath)) {
    throw new Error('bubblewrapPath must be absolute');
  }
  const prlimitPath = options.prlimitPath ?? DEFAULT_PRLIMIT_PATH;
  if (typeof prlimitPath !== 'string' || !isAbsolute(prlimitPath)) {
    throw new Error('prlimitPath must be absolute');
  }
  if (!Array.isArray(options.runtimeFilePaths) || options.runtimeFilePaths.length === 0) {
    throw new Error('runtimeFilePaths must name the exact non-empty native runtime closure');
  }
  const runtimeFilePaths = [...new Set(options.runtimeFilePaths)];
  for (const runtimePath of runtimeFilePaths) validateRuntimePath(runtimePath, options);
  return Object.freeze({
    executablePath: options.executablePath,
    cargoLockPath: options.cargoLockPath,
    identity: Object.freeze({
      ...options.identity,
      qualification: Object.freeze({ ...options.identity.qualification }),
    }),
    timeoutMs: positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    maxInputBytes: positiveLimit(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 'maxInputBytes'),
    maxOutputBytes: positiveLimit(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    ),
    maxDiagnosticBytes: positiveLimit(
      options.maxDiagnosticBytes,
      DEFAULT_MAX_DIAGNOSTIC_BYTES,
      'maxDiagnosticBytes',
    ),
    cleanupTimeoutMs: positiveLimit(
      options.cleanupTimeoutMs,
      DEFAULT_CLEANUP_TIMEOUT_MS,
      'cleanupTimeoutMs',
    ),
    preflightTimeoutMs: positiveLimit(
      options.preflightTimeoutMs,
      DEFAULT_PREFLIGHT_TIMEOUT_MS,
      'preflightTimeoutMs',
    ),
    pathEnvironment: options.pathEnvironment ?? '/usr/local/bin:/usr/bin:/bin',
    bubblewrapPath: options.bubblewrapPath,
    prlimitPath,
    sandboxTmpfsBytes: positiveLimit(
      options.sandboxTmpfsBytes,
      DEFAULT_SANDBOX_TMPFS_BYTES,
      'sandboxTmpfsBytes',
    ),
    maxDataBytes: positiveLimit(options.maxDataBytes, DEFAULT_MAX_DATA_BYTES, 'maxDataBytes'),
    maxFileBytes: positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes'),
    maxOpenFiles: positiveLimit(options.maxOpenFiles, DEFAULT_MAX_OPEN_FILES, 'maxOpenFiles'),
    runtimeFilePaths: Object.freeze(runtimeFilePaths),
    allowScriptExecutableForTests: options.allowScriptExecutableForTests ?? false,
    afterPinVerification: options.afterPinVerification,
  });
}

function validateRuntimePath(path: string, options: PinnedLiminalProcessOptions): void {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) {
    throw new Error('every runtimeFilePaths entry must be a normalized absolute path');
  }
  const isSystemLibrary = ['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/'].some((root) =>
    path.startsWith(root),
  );
  const isTestInterpreter =
    options.allowScriptExecutableForTests === true && path === process.execPath;
  if (!isSystemLibrary && !isTestInterpreter) {
    throw new Error(
      'runtimeFilePaths may expose only native system libraries and the test interpreter',
    );
  }
}
