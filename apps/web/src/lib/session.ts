import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, get, parseDocumentsResponse, type Caller } from './api';
import {
  type AuthorityContext,
  loadWebIdentityConfig,
  openWebSession,
  sanitizeReturnTo,
  SESSION_COOKIE,
  type DogfoodIdentityConfig,
  type WebSession,
} from './auth';
import type { ContextCheck } from './auth/resume';
import { developmentCaller } from './caller';

export function dogfoodConfig(): DogfoodIdentityConfig {
  const config = loadWebIdentityConfig();
  if (config.profile !== 'dogfood') throw new Error('dogfood OIDC route used in development');
  return config;
}

export async function currentWebSession(): Promise<WebSession | undefined> {
  const config = loadWebIdentityConfig();
  if (config.profile !== 'dogfood') return undefined;
  const compact = (await cookies()).get(SESSION_COOKIE)?.value;
  return openWebSession(compact, config.sessionKey);
}

/** Resolve request identity. Dogfood never falls back to fixed headers. */
export async function webCaller(returnTo = '/documents'): Promise<Caller> {
  const config = loadWebIdentityConfig();
  if (config.profile === 'development') return developmentCaller();
  const session = await currentWebSession();
  const safeReturn = sanitizeReturnTo(returnTo);
  if (session === undefined) {
    redirect(`/auth/login?next=${encodeURIComponent(safeReturn)}`);
  }
  if (session.context === undefined) {
    redirect(`/session/select?next=${encodeURIComponent(safeReturn)}`);
  }
  return {
    authentication: 'oidc',
    actorId: session.subject,
    bearerToken: session.accessToken,
    ...session.context,
  };
}

/**
 * Ask the API whether this session may act in `context`. The one check both a fresh selection
 * and a renewed session pass through before a context is sealed into the session cookie.
 */
export async function confirmContextWithApi(
  session: WebSession,
  context: AuthorityContext,
): Promise<ContextCheck> {
  const caller: Caller = {
    authentication: 'oidc',
    actorId: session.subject,
    bearerToken: session.accessToken,
    ...context,
  };
  try {
    // This is not a client-side guess. API verifies bearer subject, active role assignment,
    // organization boundary and classification context before selection is persisted.
    await get('/documents', caller, parseDocumentsResponse);
    return 'confirmed';
  } catch (error: unknown) {
    return error instanceof ApiError && error.isRefusal ? 'refused' : 'unavailable';
  }
}
