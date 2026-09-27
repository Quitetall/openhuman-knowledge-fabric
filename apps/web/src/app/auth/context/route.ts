import { NextResponse, type NextRequest } from 'next/server';
import {
  CONTEXT_HINT_COOKIE,
  CONTEXT_HINT_LIFETIME_SECONDS,
  openWebSession,
  publicOrigin,
  publicUrl,
  sanitizeReturnTo,
  sealContextHint,
  sealWebSession,
  SESSION_COOKIE,
  validateContextSelection,
} from '../../../lib/auth';
import { confirmContextWithApi, dogfoodConfig } from '../../../lib/session';

const MAX_CONTEXT_BODY_BYTES = 4_096;

async function boundedBody(request: NextRequest): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTEXT_BODY_BYTES)) {
    return undefined;
  }
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_CONTEXT_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function selectUrl(request: NextRequest, next: string, error: string): URL {
  const url = publicUrl(request, '/session/select');
  url.searchParams.set('next', next);
  url.searchParams.set('error', error);
  return url;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = dogfoodConfig();
  } catch {
    return NextResponse.redirect(publicUrl(request, '/documents'), 303);
  }
  if (request.headers.get('origin') !== publicOrigin(request)) {
    return NextResponse.json({ error: 'cross_origin_context_selection_refused' }, { status: 403 });
  }
  if (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  ) {
    return NextResponse.json(
      { error: 'unsupported_context_selection_media_type' },
      { status: 415 },
    );
  }
  let body: string | undefined;
  try {
    body = await boundedBody(request);
  } catch {
    return NextResponse.json({ error: 'invalid_context_selection_body' }, { status: 400 });
  }
  if (body === undefined) {
    return NextResponse.json({ error: 'context_selection_too_large' }, { status: 413 });
  }
  const session = await openWebSession(
    request.cookies.get(SESSION_COOKIE)?.value,
    config.sessionKey,
  );
  if (session === undefined) {
    return NextResponse.redirect(publicUrl(request, '/auth/login?next=/documents'), 303);
  }
  const form = new URLSearchParams(body);
  const next = sanitizeReturnTo(
    typeof form.get('next') === 'string' ? String(form.get('next')) : null,
  );
  let context;
  try {
    context = validateContextSelection({
      actingRoleId: form.get('actingRoleId'),
      organizationId: form.get('organizationId'),
      maxClassification: form.get('maxClassification'),
    });
  } catch {
    return NextResponse.redirect(selectUrl(request, next, 'invalid'), 303);
  }

  const check = await confirmContextWithApi(session, context);
  if (check !== 'confirmed') {
    return NextResponse.redirect(
      selectUrl(request, next, check === 'refused' ? 'denied' : 'unavailable'),
      303,
    );
  }

  const compact = await sealWebSession({ ...session, context }, config.sessionKey);
  const response = NextResponse.redirect(publicUrl(request, next), 303);
  response.cookies.set(SESSION_COOKIE, compact, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    priority: 'high',
    expires: new Date(session.expiresAt * 1000),
  });
  // Remembered so the next renewal can skip this page. Counted from the choice, not slid on each
  // renewal, so the person confirms a context at least once in every working day.
  const hintExpiresAt = Math.floor(Date.now() / 1000) + CONTEXT_HINT_LIFETIME_SECONDS;
  response.cookies.set(
    CONTEXT_HINT_COOKIE,
    await sealContextHint(
      { subject: session.subject, ...context },
      hintExpiresAt,
      config.sessionKey,
    ),
    {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(hintExpiresAt * 1000),
    },
  );
  return response;
}
