import { NextResponse, type NextRequest } from 'next/server';
import {
  CONTEXT_HINT_COOKIE,
  ID_TOKEN_HINT_COOKIE,
  OIDC_TRANSACTION_COOKIE,
  openOidcTransaction,
  sealIdTokenHint,
  sealWebSession,
  publicUrl,
  SESSION_COOKIE,
} from '../../../lib/auth';
import { resumeChosenContext } from '../../../lib/auth/resume';
import { discoverOidc, exchangeAuthorizationCode } from '../../../lib/oidc';
import { confirmContextWithApi, dogfoodConfig } from '../../../lib/session';

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
    NextResponse.redirect(publicUrl(request, `/auth/error?code=${encodeURIComponent(code)}`)),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = dogfoodConfig();
  } catch {
    return NextResponse.redirect(publicUrl(request, '/documents'));
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
    const { session, idToken } = await exchangeAuthorizationCode(
      metadata,
      config,
      transaction,
      code,
    );
    // A session lives only as long as its access token, so a person renews every few minutes.
    // The context they chose earlier is offered again only if the API accepts it for this new
    // token; otherwise they choose, exactly as on a first sign-in.
    const resumed = await resumeChosenContext(
      request.cookies.get(CONTEXT_HINT_COOKIE)?.value,
      session,
      config.sessionKey,
      (context) => confirmContextWithApi(session, context),
    );
    const compact = await sealWebSession(
      resumed.kind === 'resumed' ? { ...session, context: resumed.context } : session,
      config.sessionKey,
    );
    const hint = await sealIdTokenHint(idToken, session.expiresAt, config.sessionKey);
    let destination: URL;
    if (resumed.kind === 'resumed') {
      destination = publicUrl(request, transaction.returnTo);
    } else {
      destination = publicUrl(request, '/session/select');
      destination.searchParams.set('next', transaction.returnTo);
    }
    const response = clearTransaction(NextResponse.redirect(destination));
    if (resumed.kind === 'choose' && resumed.discardHint) {
      response.cookies.set(CONTEXT_HINT_COOKIE, '', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        expires: new Date(0),
      });
    }
    response.cookies.set(SESSION_COOKIE, compact, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      priority: 'high',
      expires: new Date(session.expiresAt * 1000),
    });
    if (hint !== undefined) {
      response.cookies.set(ID_TOKEN_HINT_COOKIE, hint, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        expires: new Date(session.expiresAt * 1000),
      });
    }
    return response;
  } catch {
    return failed(request, 'token_rejected');
  }
}
