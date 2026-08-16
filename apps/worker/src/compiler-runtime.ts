/** Operational, fail-closed bridge from one recorded compilation request to one receipt. */

export { compilationOutboxHandler } from './compiler-runtime/outbox.js';
export { createPostgresCompilerRuntimeRepository } from './compiler-runtime/postgres-repository.js';
export { createCompilationRuntime } from './compiler-runtime/runtime.js';
export type {
  CompilationRuntime,
  CompilerInputKind,
  CompilerInputReference,
  CompilerRuntimeRepository,
  CompilerRuntimeRequest,
  CompilerRuntimeResult,
  ExistingCompilation,
  MaterializedCompiledView,
  RecordedCompiledView,
} from './compiler-runtime/types.js';
export { parseCompilerRuntimeRequest } from './compiler-runtime/validation.js';
