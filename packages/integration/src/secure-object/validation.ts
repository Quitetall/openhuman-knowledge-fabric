import {
  DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS,
  MAX_AUTHORITY_SIGNER_TIMEOUT_MS,
  type ContentSha256,
  type ExternalAuthorityRef,
  type ExternalRevisionRef,
  type PolicyDecisionRef,
  SecureObjectRejected,
  type WorkloadIdentityRef,
} from './contracts.js';

const SAFE_OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;

export function opaqueReference(value: string, label: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || !SAFE_OPAQUE_REF.test(value)) {
    throw new SecureObjectRejected(
      'invalid_reference',
      `${label} must be an opaque token of at most ${maximum} characters`,
    );
  }
  return value;
}

/** Brand an external authority reference without interpreting or resolving it. */
export function externalAuthorityRef(value: string): ExternalAuthorityRef {
  return opaqueReference(value, 'authority reference', 512) as ExternalAuthorityRef;
}

/** Brand an immutable external revision reference without interpreting or resolving it. */
export function externalRevisionRef(value: string): ExternalRevisionRef {
  return opaqueReference(value, 'revision reference', 512) as ExternalRevisionRef;
}

/** Brand workload identity chosen by deployment authentication, never by protected content. */
export function workloadIdentityRef(value: string): WorkloadIdentityRef {
  return opaqueReference(value, 'workload identity reference', 255) as WorkloadIdentityRef;
}

/** Brand immutable authorization decision identity produced by policy evaluation. */
export function policyDecisionRef(value: string): PolicyDecisionRef {
  return opaqueReference(value, 'policy decision reference', 255) as PolicyDecisionRef;
}

/** Validate an exact external object's raw-byte SHA-256 identity. */
export function contentSha256(value: string): ContentSha256 {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new SecureObjectRejected(
      'invalid_digest',
      'external content digest must be exactly 64 lowercase SHA-256 hex characters',
    );
  }
  return value as ContentSha256;
}

export function validateIdempotencyKey(value: string): void {
  if (value.length < 8 || value.length > 128 || !SAFE_OPAQUE_REF.test(value)) {
    throw new SecureObjectRejected(
      'invalid_idempotency_key',
      'idempotency key must contain 8-128 non-padding characters',
    );
  }
}

export function canonicalBase64Bytes(value: string, expectedLength: number): Buffer | undefined {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === expectedLength && bytes.toString('base64') === value
      ? bytes
      : undefined;
  } catch {
    return undefined;
  }
}

export function authoritySignerTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_AUTHORITY_SIGNER_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_AUTHORITY_SIGNER_TIMEOUT_MS) {
    throw new SecureObjectRejected(
      'invalid_timeout',
      `authority signer timeout must be 1-${MAX_AUTHORITY_SIGNER_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeout;
}

export async function signWithDeadline(
  signer: (bytes: Uint8Array, signal: AbortSignal) => Uint8Array | Promise<Uint8Array>,
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const failure = new SecureObjectRejected(
        'signer_timeout',
        `external Secure Object Authority signer exceeded ${timeoutMs} milliseconds`,
      );
      // Settle deadline first. A signer that synchronously reacts to abort cannot win the
      // race after its deadline and smuggle in a boundary-time signature.
      reject(failure);
      controller.abort(failure);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => signer(bytes, controller.signal)),
      deadline,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
