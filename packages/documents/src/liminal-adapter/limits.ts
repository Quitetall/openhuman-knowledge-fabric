export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
export const PREFLIGHT_TIMEOUT_MS = 5_000;
export const PREFLIGHT_RESPONSE = '{"protocol":"kf-document-v1","status":"ready"}\n';
export const MAX_PREFLIGHT_RESPONSE_BYTES = Buffer.byteLength(PREFLIGHT_RESPONSE);
export const MAX_RUNTIME_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_RUNTIME_CLOSURE_BYTES = 512 * 1024 * 1024;
export const HASH_BUFFER_BYTES = 64 * 1024;

export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return selected;
}

export function boundedMessage(chunks: readonly Buffer[], fallback: string): string {
  const message = Buffer.concat(chunks).toString('utf8').trim();
  return message === '' ? fallback : message;
}
