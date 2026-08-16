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
  try {
    const url = new URL(value, 'https://knowledge-fabric.invalid');
    return url.origin === 'https://knowledge-fabric.invalid'
      ? `${url.pathname}${url.search}${url.hash}`
      : '/documents';
  } catch {
    return '/documents';
  }
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

function uuidV7(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function validateContextSelection(input: {
  readonly actingRoleId: unknown;
  readonly organizationId: unknown;
  readonly maxClassification: unknown;
}): AuthorityContext {
  if (!uuidV7(input.actingRoleId)) throw new Error('acting role must be a UUIDv7');
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
