import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { loadWebIdentityConfig } from '../lib/auth';
import { DENSITY_COOKIE, parseDensity, type Density } from '../lib/density';
import { currentWebSession } from '../lib/session';
import { NeedsYouCount } from './components/needs-you-count';
import { SessionStatus } from './components/session-status';
import { setDensity } from './density/actions';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Knowledge Fabric',
    template: '%s | Knowledge Fabric',
  },
  description: 'Institutional information platform — OH-DOC-000002-1-R01',
};

// Identity and authority context are request-scoped. Never evaluate their runtime
// configuration while producing a static build artifact.
export const dynamic = 'force-dynamic';

/** The density switch (KF-SAS-RQ-276): a form, so it works without script. */
function DensitySwitch({ density }: { readonly density: Density }) {
  const other: Density = density === 'compact' ? 'comfortable' : 'compact';
  return (
    <form action={setDensity} className="kf-density">
      <input type="hidden" name="density" value={other} />
      <button
        type="submit"
        className="kf-density-button"
        aria-label={`Density is ${density}. Switch to ${other}.`}
        data-density-switch={other}
      >
        {density === 'compact' ? 'Roomier view' : 'Compact view'}
      </button>
    </form>
  );
}

/** A link in the primary navigation. Plain words; every target is a page anyone may open. */
function NavLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <Link href={href} className="kf-nav-link">
      {children}
    </Link>
  );
}

/**
 * The masthead: who is signed in, then where to go. The same links for everyone (KF-SAS-RQ-262):
 * what each page holds is the API's answer for the person, never the navigation's choice. The
 * pages a person uses every day come first; the rest wait under "More".
 */
async function Masthead({ density }: { readonly density: Density }) {
  const signedIn =
    loadWebIdentityConfig().profile === 'development' || (await currentWebSession()) !== undefined;
  return (
    <header className="kf-masthead">
      <div className="kf-masthead-top">
        <Link href="/" className="kf-wordmark">
          Knowledge Fabric
        </Link>
        <Suspense fallback={<span className="kf-session-status">…</span>}>
          <SessionStatus />
        </Suspense>
      </div>
      {signedIn ? (
        <nav aria-label="Primary" className="kf-primary-nav">
          <NavLink href="/">Home</NavLink>
          <NavLink href="/agent">Ask</NavLink>
          <NavLink href="/search">Search</NavLink>
          <NavLink href="/add">Add files</NavLink>
          <NavLink href="/capture">Quick note</NavLink>
          <Link href="/needs-you" className="kf-nav-link">
            Needs you
            <Suspense fallback={null}>
              <NeedsYouCount />
            </Suspense>
          </Link>
          <details className="kf-more-menu">
            <summary className="kf-nav-link">More</summary>
            <div className="kf-more-list">
              <Link href="/master-document">Your master document</Link>
              <Link href="/documents">Controlled documents</Link>
              <Link href="/ml/runs">ML runs</Link>
              <Link href="/ai-answers">AI answers</Link>
              <Link href="/status">Service status</Link>
              <DensitySwitch density={density} />
            </div>
          </details>
        </nav>
      ) : null}
    </header>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const density = parseDensity((await cookies()).get(DENSITY_COOKIE)?.value);
  return (
    <html lang="en" data-density={density}>
      <body>
        <Masthead density={density} />
        {children}
      </body>
    </html>
  );
}
