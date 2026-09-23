import { NextResponse, type NextRequest } from 'next/server';
import {
  ID_TOKEN_HINT_COOKIE,
  OIDC_TRANSACTION_COOKIE,
  openIdTokenHint,
  publicOrigin,
  publicUrl,
  SESSION_COOKIE,
} from '../../../lib/auth';
import { discoverOidc, logoutUrl } from '../../../lib/oidc';
import { dogfoodConfig } from '../../../lib/session';

function expire(response: NextResponse): NextResponse {
  for (const name of [SESSION_COOKIE, OIDC_TRANSACTION_COOKIE, ID_TOKEN_HINT_COOKIE]) {
    response.cookies.set(name, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(0),
    });
  }
  return response;
}

/**
 * Sign out: always end the local session, then end the provider's when it can be reached.
 *
 * Every branch clears the cookies, including the ones that refuse. A person pressing "sign
 * out" on a shared machine must not stay signed in because the configuration failed to load
 * or a proxy rewrote the origin; the worst a cross-origin POST can then do is sign somebody
 * out, which is a nuisance and not a disclosure. What a refusal withholds is the redirect to
 * the provider.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = dogfoodConfig();
  } catch {
    return expire(NextResponse.redirect(publicUrl(request, '/'), 303));
  }
  if (request.headers.get('origin') !== publicOrigin(request)) {
    return expire(NextResponse.json({ error: 'cross_origin_logout_refused' }, { status: 403 }));
  }
  const destination = new URL('/', config.redirectUri).toString();
  const idTokenHint = await openIdTokenHint(
    request.cookies.get(ID_TOKEN_HINT_COOKIE)?.value,
    config.sessionKey,
  );
  try {
    const metadata = await discoverOidc(config);
    return expire(
      NextResponse.redirect(
        logoutUrl(metadata, config, destination, idTokenHint) ?? new URL(destination),
        303,
      ),
    );
  } catch {
    return expire(NextResponse.redirect(new URL(destination), 303));
  }
}
