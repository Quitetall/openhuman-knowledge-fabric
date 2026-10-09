/** The compiler environment the worker and the determinism re-run share. */

import { StoreRegistry, type ObjectStore } from '@kf/artifacts';
import { withTransaction, type Pool } from '@kf/database';
import {
  PinnedLiminalProcessAdapter,
  preflightLiminalProcessHost,
  type DocumentCompilerAdapter,
  type LiminalCompilerIdentity,
} from '@kf/documents';
import { loadSecret } from '@kf/operations';
import {
  createPostgresCompilerRuntimeRepository,
  type CompilerRuntimeRepository,
} from './compiler-runtime.js';

export interface CompilerEnvironment {
  readonly repository: CompilerRuntimeRepository;
  readonly store: ObjectStore;
  readonly adapterFor: (identity: LiminalCompilerIdentity) => DocumentCompilerAdapter;
}

function configured(name: string): boolean {
  return process.env[name] !== undefined || process.env[`${name}_FILE`] !== undefined;
}

function liminalRuntimeFilePaths(): readonly string[] {
  const configuredPaths = process.env['LIMINAL_RUNTIME_FILE_PATHS'];
  if (configuredPaths === undefined) return [];
  return configuredPaths
    .split(':')
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

/**
 * What compiling needs on this host — the worker's request repository, the registered `working`
 * store and the pinned Liminal adapter — or undefined when no Liminal setting is present. Shared
 * by the worker's runtime and the scheduled determinism re-run (`determinism-cli.ts`), so the
 * re-run compiles exactly as the worker does.
 */
export async function compilerEnvironment(pool: Pool): Promise<CompilerEnvironment | undefined> {
  const liminal = [
    'LIMINAL_COMPILER_PATH',
    'LIMINAL_CARGO_LOCK_PATH',
    'LIMINAL_BWRAP_PATH',
    'LIMINAL_RUNTIME_FILE_PATHS',
    'LIMINAL_EXECUTABLE_SHA256',
    'LIMINAL_CARGO_LOCK_SHA256',
    'LIMINAL_RUNTIME_CLOSURE_SHA256',
  ] as const;
  const configuredLiminal = liminal.filter((name) => process.env[name] !== undefined);
  if (configuredLiminal.length === 0) return undefined;
  const required = [
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_BUCKET_ARTIFACTS',
    ...liminal,
  ] as const;
  const configuredValues = required.filter((name) => process.env[name] !== undefined);
  const secretConfigured = configured('S3_SECRET_ACCESS_KEY');
  if (configuredValues.length !== required.length || !secretConfigured) {
    throw new Error(
      `${required.join(', ')}, and S3_SECRET_ACCESS_KEY[_FILE] must all be set for document compilation`,
    );
  }

  // Resolved against the registered `working` row before a client exists (KF-SAS-RQ-095): a
  // worker configured with another bucket refuses to start rather than compiling into it.
  const working = {
    endpoint: process.env['S3_ENDPOINT']!,
    region: process.env['S3_REGION']!,
    accessKeyId: process.env['S3_ACCESS_KEY_ID']!,
    secretAccessKey: loadSecret('S3_SECRET_ACCESS_KEY', process.env, {
      allowInline: process.env['NODE_ENV'] !== 'production',
    }),
    bucket: process.env['S3_BUCKET_ARTIFACTS']!,
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] !== 'false',
  };
  const registry = await withTransaction(pool, (tx) => StoreRegistry.fromDatabase(tx, { working }));
  const store = registry.get('working');
  if (store === undefined) throw new Error('the working store did not resolve');
  const runtimeFilePaths = liminalRuntimeFilePaths();
  await preflightLiminalProcessHost({
    executablePath: process.env['LIMINAL_COMPILER_PATH']!,
    cargoLockPath: process.env['LIMINAL_CARGO_LOCK_PATH']!,
    executableDigest: process.env['LIMINAL_EXECUTABLE_SHA256']!,
    cargoLockDigest: process.env['LIMINAL_CARGO_LOCK_SHA256']!,
    runtimeClosureDigest: process.env['LIMINAL_RUNTIME_CLOSURE_SHA256']!,
    bubblewrapPath: process.env['LIMINAL_BWRAP_PATH']!,
    runtimeFilePaths,
  });
  return {
    repository: createPostgresCompilerRuntimeRepository(pool),
    store,
    adapterFor: (identity) =>
      new PinnedLiminalProcessAdapter({
        identity,
        executablePath: process.env['LIMINAL_COMPILER_PATH']!,
        cargoLockPath: process.env['LIMINAL_CARGO_LOCK_PATH']!,
        bubblewrapPath: process.env['LIMINAL_BWRAP_PATH']!,
        runtimeFilePaths,
      }),
  };
}
