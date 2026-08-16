import { digestOf, type ObjectStore } from '@kf/artifacts';
import {
  DocumentCompilerError,
  type CompilationRequest,
  type CompilerInput,
  type DocumentCompilerAdapter,
} from '@kf/documents';
import type { CompilerInputReference } from './types.js';

export interface LoadedCompilerInputs {
  readonly inputs: readonly CompilerInput[];
  readonly failure?: { readonly code: string; readonly message: string };
}

function isObjectReadLimitExceeded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'object_read_limit_exceeded'
  );
}

function canonicalInputBytes(request: CompilationRequest): number {
  // JCS key ordering changes byte order, not byte count. CompilationRequest is already verified
  // JSON data, so JSON.stringify gives exact canonical-envelope length without another package
  // dependency in worker. Liminal writes one trailing newline after canonical JSON.
  const serialized = JSON.stringify(request);
  if (serialized === undefined) throw new Error('compiler request is not JSON serializable');
  return Buffer.byteLength(serialized, 'utf8') + 1;
}

export function boundedAdapter(
  adapter: DocumentCompilerAdapter,
  maxCanonicalInputBytes: number,
): DocumentCompilerAdapter {
  return {
    identity: adapter.identity,
    async compile(request) {
      if (canonicalInputBytes(request) > maxCanonicalInputBytes) {
        throw new DocumentCompilerError(
          'input_size_limit_exceeded',
          `canonical compiler input exceeded ${String(maxCanonicalInputBytes)} bytes`,
        );
      }
      return adapter.compile(request);
    },
  };
}

export async function loadCompilerInputs(
  store: ObjectStore,
  references: readonly CompilerInputReference[],
  maxSourceBytes: number,
): Promise<LoadedCompilerInputs> {
  let declaredBytes = 0;
  for (const input of references) {
    declaredBytes += input.sizeBytes;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxSourceBytes) break;
  }

  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxSourceBytes) {
    return {
      inputs: [],
      failure: {
        code: 'input_size_limit_exceeded',
        message: `declared compiler source bytes exceed ${String(maxSourceBytes)}`,
      },
    };
  }

  const inputs: CompilerInput[] = [];
  let bytesRead = 0;
  for (const input of references) {
    const remainingBytes = maxSourceBytes - bytesRead;
    const readCap = Math.min(input.sizeBytes, remainingBytes);
    let bytes: Buffer;
    try {
      bytes = await store.read(input.storageUri, input.storageVersion, readCap);
    } catch (error: unknown) {
      if (!isObjectReadLimitExceeded(error)) throw error;
      return {
        inputs,
        failure: {
          code: 'input_size_limit_exceeded',
          message: `${input.kind}:${input.id} exceeded declared or remaining read cap ${String(readCap)}`,
        },
      };
    }
    bytesRead += bytes.byteLength;
    if (!Number.isSafeInteger(bytesRead) || bytesRead > maxSourceBytes) {
      return {
        inputs,
        failure: {
          code: 'input_size_limit_exceeded',
          message: `compiler source read exceeded ${String(maxSourceBytes)} bytes`,
        },
      };
    }
    if (digestOf(bytes) !== input.contentDigest) {
      return {
        inputs,
        failure: {
          code: 'input_digest_mismatch',
          message: `${input.kind}:${input.id} bytes do not match their contentDigest`,
        },
      };
    }
    if (bytes.length !== input.sizeBytes) {
      return {
        inputs,
        failure: {
          code: 'input_size_mismatch',
          message: `${input.kind}:${input.id} stored size does not match immutable version metadata`,
        },
      };
    }
    inputs.push({
      kind: input.kind,
      id: input.id,
      bytesBase64: bytes.toString('base64'),
      contentDigest: input.contentDigest,
    });
  }
  return { inputs };
}
