import { NextResponse, type NextRequest } from 'next/server';
import { getSessionContexts, type SessionContexts } from '../../../lib/api';
import {
  CONTEXT_HINT_COOKIE,
  CONTEXT_HINT_LIFETIME_SECONDS,
  decideContext,
  ID_TOKEN_HINT_COOKIE,
  IDENTITY_LABEL_COOKIE,
  identityLabel,
  OIDC_TRANSACTION_COOKIE,
  openIdentityLabel,
  openOidcTransaction,
  sealContextHint,
  sealIdentityLabel,
  sealIdTokenHint,
  sealWebSession,
  publicUrl,
  SESSION_COOKIE,
  type AuthorityContext,
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
    const { session, idToken, displayName } = await exchangeAuthorizationCode(
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
    let context: AuthorityContext | undefined =
      resumed.kind === 'resumed' ? resumed.context : undefined;
    const knownLabel = await openIdentityLabel(
      request.cookies.get(IDENTITY_LABEL_COOKIE)?.value,
      config.sessionKey,
      session.subject,
    );
    // The API's menu is read when there is something to decide or nothing to call the person by.
    // A renewal with a remembered context and label reads nothing more than it did before.
    let contexts: SessionContexts | undefined;
    if (context === undefined || knownLabel === undefined) {
      try {
        contexts = await getSessionContexts(session.accessToken);
      } catch {
        contexts = undefined;
      }
    }
    // Exactly one live assignment: nothing to choose, so it is proposed — at the person's own
    // clearance — and kept only if the API confirms it exactly as it confirms a picker choice.
    // Anything else, or any refusal, is the picker (lib/auth/auto-context.ts).
    let chosenHere = false;
    if (context === undefined && contexts !== undefined) {
      const decision = decideContext(contexts);
      if (
        decision.kind === 'auto' &&
        (await confirmContextWithApi(session, decision.context)) === 'confirmed'
      ) {
        context = decision.context;
        chosenHere = true;
      }
    }
    const compact = await sealWebSession(
      context === undefined ? session : { ...session, context },
      config.sessionKey,
    );
    const hint = await sealIdTokenHint(idToken, session.expiresAt, config.sessionKey);
    let destination: URL;
    if (context !== undefined) {
      destination = publicUrl(request, transaction.returnTo);
    } else {
      destination = publicUrl(request, '/session/select');
      destination.searchParams.set('next', transaction.returnTo);
    }
    const response = clearTransaction(NextResponse.redirect(destination));
    const rememberedUntil = Math.floor(Date.now() / 1000) + CONTEXT_HINT_LIFETIME_SECONDS;
    if (chosenHere && context !== undefined) {
      // Remembered for renewal exactly as a picker choice is (`/auth/context`).
      response.cookies.set(
        CONTEXT_HINT_COOKIE,
        await sealContextHint(
          { subject: session.subject, ...context },
          rememberedUntil,
          config.sessionKey,
        ),
        {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          expires: new Date(rememberedUntil * 1000),
        },
      );
    }
    if (contexts !== undefined) {
      const label = await sealIdentityLabel(
        identityLabel(session.subject, displayName ?? knownLabel?.personName, contexts),
        rememberedUntil,
        config.sessionKey,
      );
      if (label !== undefined) {
        response.cookies.set(IDENTITY_LABEL_COOKIE, label, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          expires: new Date(rememberedUntil * 1000),
        });
      }
    }
    if (resumed.kind === 'choose' && resumed.discardHint && !chosenHere) {
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
