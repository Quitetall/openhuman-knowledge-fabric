import { EncryptJWT, jwtDecrypt, type JWTPayload } from 'jose';
import { validateContextSelection } from './context';
import { MAX_WEB_COOKIE_VALUE_BYTES, type OidcTransaction, type WebSession } from './types';

type CookieKind = 'kf-web-session-v1' | 'kf-oidc-transaction-v1';

async function seal(
  kind: CookieKind,
  payload: Readonly<Record<string, unknown>>,
  expiresAt: number,
  key: Uint8Array,
): Promise<string> {
  return new EncryptJWT({ kind, data: payload })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: kind })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .encrypt(key);
}

async function open(
  compact: string | undefined,
  expectedKind: CookieKind,
  key: Uint8Array,
): Promise<JWTPayload | undefined> {
  if (
    compact === undefined ||
    compact === '' ||
    Buffer.byteLength(compact, 'utf8') > MAX_WEB_COOKIE_VALUE_BYTES
  ) {
    return undefined;
  }
  try {
    const result = await jwtDecrypt(compact, key, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    if (result.protectedHeader.typ !== expectedKind || result.payload['kind'] !== expectedKind) {
      return undefined;
    }
    return result.payload;
  } catch {
    return undefined;
  }
}

function enforceCookieBudget(compact: string, kind: string): string {
  if (Buffer.byteLength(compact, 'utf8') > MAX_WEB_COOKIE_VALUE_BYTES) {
    throw new Error(`${kind} exceeds the encrypted browser cookie budget`);
  }
  return compact;
}

export async function sealOidcTransaction(
  transaction: OidcTransaction,
  key: Uint8Array,
): Promise<string> {
  return enforceCookieBudget(
    await seal(
      'kf-oidc-transaction-v1',
      transaction as unknown as Readonly<Record<string, unknown>>,
      transaction.expiresAt,
      key,
    ),
    'OIDC transaction',
  );
}

export async function openOidcTransaction(
  compact: string | undefined,
  key: Uint8Array,
): Promise<OidcTransaction | undefined> {
  const envelope = await open(compact, 'kf-oidc-transaction-v1', key);
  const data = envelope?.['data'];
  if (typeof data !== 'object' || data === null) return undefined;
  const value = data as Record<string, unknown>;
  if (
    typeof value['state'] !== 'string' ||
    typeof value['nonce'] !== 'string' ||
    typeof value['verifier'] !== 'string' ||
    typeof value['challenge'] !== 'string' ||
    typeof value['returnTo'] !== 'string' ||
    typeof value['expiresAt'] !== 'number'
  ) {
    return undefined;
  }
  return value as unknown as OidcTransaction;
}

export async function sealWebSession(session: WebSession, key: Uint8Array): Promise<string> {
  const compact = await seal(
    'kf-web-session-v1',
    session as unknown as Readonly<Record<string, unknown>>,
    session.expiresAt,
    key,
  );
  enforceCookieBudget(compact, 'Web session');
  if (session.context === undefined) {
    // Reserve the worst valid context before accepting a provider token. This prevents login
    // from succeeding only to fail when the API-approved UUIDv7 context is added.
    const withContext = await seal(
      'kf-web-session-v1',
      {
        ...session,
        context: {
          actingRoleId: '00000000-0000-7000-8000-000000000000',
          organizationId: '00000000-0000-7000-8000-000000000000',
          maxClassification: 'confidential',
        },
      } as unknown as Readonly<Record<string, unknown>>,
      session.expiresAt,
      key,
    );
    enforceCookieBudget(withContext, 'Web session with authority context');
  }
  return compact;
}

export async function openWebSession(
  compact: string | undefined,
  key: Uint8Array,
): Promise<WebSession | undefined> {
  const envelope = await open(compact, 'kf-web-session-v1', key);
  const data = envelope?.['data'];
  if (typeof data !== 'object' || data === null) return undefined;
  const value = data as Record<string, unknown>;
  if (
    value['version'] !== 1 ||
    typeof value['accessToken'] !== 'string' ||
    value['accessToken'].length === 0 ||
    typeof value['subject'] !== 'string' ||
    value['subject'].length === 0 ||
    typeof value['expiresAt'] !== 'number'
  ) {
    return undefined;
  }
  if (value['context'] !== undefined) {
    try {
      const context = value['context'] as Record<string, unknown>;
      validateContextSelection({
        actingRoleId: context['actingRoleId'],
        organizationId: context['organizationId'],
        maxClassification: context['maxClassification'],
      });
    } catch {
      return undefined;
    }
  }
  return value as unknown as WebSession;
}
