import { createHash, randomBytes } from 'node:crypto';
import { CLASSIFICATIONS, type AuthorityContext, type OidcTransaction } from './types';

export function sanitizeReturnTo(value: string | null | undefined): string {
  const hasUnsafeCharacter =
    value !== undefined &&
    value !== null &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    });
  if (
    value === undefined ||
    value === null ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasUnsafeCharacter
  ) {
    return '/documents';
  }
  let normalised: string;
  try {
    const url = new URL(value, 'https://knowledge-fabric.invalid');
    if (url.origin !== 'https://knowledge-fabric.invalid') return '/documents';
    normalised = `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/documents';
  }
  // The checks above ran on the input; what leaves is the NORMALISED path, and normalising can
  // manufacture what they refused. `/.//evil.com`, `/a/..//evil.com` and `/%2e//evil.com` all
  // collapse to `//evil.com`, which a browser reads as another host. So the output is checked
  // again, and it must be a fixed point: sanitising it once more changes nothing.
  if (
    normalised.startsWith('//') ||
    normalised.includes('\\') ||
    /^\/*[a-z][a-z0-9+.-]*:/i.test(normalised)
  ) {
    return '/documents';
  }
  return normalised;
}

/** Create one-use authorization transaction. Verifier never leaves encrypted HttpOnly cookie. */
export function makePkceTransaction(
  returnTo?: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): OidcTransaction {
  const verifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    returnTo: sanitizeReturnTo(returnTo),
    expiresAt: nowSeconds + 10 * 60,
  };
}

export function uuidV7(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Any RFC 4122 UUID of versions 1 to 8. A role assignment is an immutable record, and assignments
 * minted before identifiers were time-ordered are version 4; refusing them here would lock their
 * holders out of a role the API still honours. The API, not this shape, decides whether it is live.
 */
function rfc4122Uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function validateContextSelection(input: {
  readonly actingRoleId: unknown;
  readonly organizationId: unknown;
  readonly maxClassification: unknown;
}): AuthorityContext {
  if (!rfc4122Uuid(input.actingRoleId)) throw new Error('acting role must be a UUID');
  if (!uuidV7(input.organizationId)) throw new Error('organization must be a UUIDv7');
  if (
    typeof input.maxClassification !== 'string' ||
    !CLASSIFICATIONS.some((value) => value === input.maxClassification)
  ) {
    throw new Error('classification must be public, internal, confidential or restricted');
  }
  return {
    actingRoleId: input.actingRoleId,
    organizationId: input.organizationId,
    maxClassification: input.maxClassification as AuthorityContext['maxClassification'],
  };
}
