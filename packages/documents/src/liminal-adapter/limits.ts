export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Default deadline for the host sandbox probe. Overridable per adapter.
 *
 * Was a fixed, unconfigurable 5s, which is not a deliberate value for what it bounds. The
 * probe spawns a real bubblewrap sandbox, reads one line of protocol and waits for exit — on
 * an idle host that is milliseconds, and it was measured at 3.5-5.3s on a host under load. So
 * 5s made a document compile fail because the machine was busy, which is not a property
 * anyone chose.
 *
 * 20s keeps the distinction that actually matters — "bounded" against "hangs forever" — with
 * roughly 4x headroom over the worst probe measured here, and stays below DEFAULT_TIMEOUT_MS
 * so a stuck preflight still fails sooner than a stuck compilation rather than becoming the
 * slower of the two.
 */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 20_000;
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
