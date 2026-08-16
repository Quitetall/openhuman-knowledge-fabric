import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Caller } from './api';
import {
  loadWebIdentityConfig,
  openWebSession,
  sanitizeReturnTo,
  SESSION_COOKIE,
  type DogfoodIdentityConfig,
  type WebSession,
} from './auth';
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
