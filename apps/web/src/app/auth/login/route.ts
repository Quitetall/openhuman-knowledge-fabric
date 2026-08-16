import { NextResponse, type NextRequest } from 'next/server';
import {
  makePkceTransaction,
  OIDC_TRANSACTION_COOKIE,
  sealOidcTransaction,
} from '../../../lib/auth';
import { authorizationUrl, discoverOidc } from '../../../lib/oidc';
import { dogfoodConfig } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const config = dogfoodConfig();
    const transaction = makePkceTransaction(request.nextUrl.searchParams.get('next'));
    const [metadata, compact] = await Promise.all([
      discoverOidc(config),
      sealOidcTransaction(transaction, config.sessionKey),
    ]);
    const response = NextResponse.redirect(authorizationUrl(metadata, config, transaction));
    response.cookies.set(OIDC_TRANSACTION_COOKIE, compact, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      priority: 'high',
      expires: new Date(transaction.expiresAt * 1000),
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL('/auth/error?code=provider_unavailable', request.url));
  }
}
