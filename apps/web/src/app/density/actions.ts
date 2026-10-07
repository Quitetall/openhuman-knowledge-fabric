'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DENSITY_COOKIE, parseDensity } from '../../lib/density';

/**
 * Remember the reader's density (KF-SAS-RQ-276). Presentation only: the cookie is read by the
 * root layout into `data-density` on <html> and by nothing else, so no reading, no request to the
 * API and no record differs between the two settings.
 */
export async function setDensity(form: FormData): Promise<void> {
  const density = parseDensity(form.get('density'));
  (await cookies()).set(DENSITY_COOKIE, density, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  const back = (await headers()).get('referer');
  let path = '/';
  if (back !== null) {
    try {
      const url = new URL(back);
      path = `${url.pathname}${url.search}`;
    } catch {
      path = '/';
    }
  }
  redirect(path.startsWith('/') && !path.startsWith('//') ? path : '/');
}
