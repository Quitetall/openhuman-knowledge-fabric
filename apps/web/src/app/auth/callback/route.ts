import { NextResponse, type NextRequest } from 'next/server';
import {
  OIDC_TRANSACTION_COOKIE,
  openOidcTransaction,
  sealWebSession,
  SESSION_COOKIE,
} from '../../../lib/auth';
import { discoverOidc, exchangeAuthorizationCode } from '../../../lib/oidc';
import { dogfoodConfig } from '../../../lib/session';

export const dynamic = 'force-dynamic';

function clearTransaction(response: NextResponse): NextResponse {
  response.cookies.set(OIDC_TRANSACTION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
  });
  return response;
}

function failed(request: NextRequest, code: string): NextResponse {
  return clearTransaction(
    NextResponse.redirect(new URL(`/auth/error?code=${encodeURIComponent(code)}`, request.url)),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = dogfoodConfig();
  } catch {
    return NextResponse.redirect(new URL('/documents', request.url));
  }
  const transaction = await openOidcTransaction(
    request.cookies.get(OIDC_TRANSACTION_COOKIE)?.value,
    config.sessionKey,
  );
  if (transaction === undefined) return failed(request, 'transaction_missing');
  if (request.nextUrl.searchParams.get('error') !== null)
    return failed(request, 'provider_refused');
  if (request.nextUrl.searchParams.get('state') !== transaction.state) {
    return failed(request, 'state_mismatch');
  }
  const code = request.nextUrl.searchParams.get('code') ?? '';
  try {
    const metadata = await discoverOidc(config);
    const session = await exchangeAuthorizationCode(metadata, config, transaction, code);
    const compact = await sealWebSession(session, config.sessionKey);
    const destination = new URL('/session/select', request.url);
    destination.searchParams.set('next', transaction.returnTo);
    const response = clearTransaction(NextResponse.redirect(destination));
    response.cookies.set(SESSION_COOKIE, compact, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      priority: 'high',
      expires: new Date(session.expiresAt * 1000),
    });
    return response;
  } catch {
    return failed(request, 'token_rejected');
  }
}
