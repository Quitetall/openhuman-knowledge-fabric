import { NextResponse, type NextRequest } from 'next/server';
import { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE } from '../../../lib/auth';
import { discoverOidc, logoutUrl } from '../../../lib/oidc';
import { dogfoodConfig } from '../../../lib/session';

function expire(response: NextResponse): NextResponse {
  for (const name of [SESSION_COOKIE, OIDC_TRANSACTION_COOKIE]) {
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = dogfoodConfig();
  } catch {
    return NextResponse.redirect(new URL('/', request.url), 303);
  }
  if (request.headers.get('origin') !== new URL(config.redirectUri).origin) {
    return NextResponse.json({ error: 'cross_origin_logout_refused' }, { status: 403 });
  }
  const destination = new URL('/', config.redirectUri).toString();
  try {
    const metadata = await discoverOidc(config);
    return expire(
      NextResponse.redirect(logoutUrl(metadata, config, destination) ?? new URL(destination), 303),
    );
  } catch {
    return expire(NextResponse.redirect(new URL(destination), 303));
  }
}
