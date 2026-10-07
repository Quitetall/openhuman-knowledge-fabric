import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { DENSITY_COOKIE, parseDensity, type Density } from '../lib/density';
import { SessionStatus } from './components/session-status';
import { setDensity } from './density/actions';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'OpenHuman Knowledge Fabric',
    template: '%s | OpenHuman Knowledge Fabric',
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
        {density === 'compact' ? 'Comfortable view' : 'Compact view'}
      </button>
    </form>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const density = parseDensity((await cookies()).get(DENSITY_COOKIE)?.value);
  return (
    <html lang="en" data-density={density}>
      <body>
        <header className="kf-masthead">
          <nav aria-label="Primary" className="kf-primary-nav">
            <Link href="/" className="kf-wordmark">
              OpenHuman Knowledge Fabric
            </Link>
            <Link href="/master-document" className="kf-nav-link">
              Master document
            </Link>
            <Link href="/documents" className="kf-nav-link">
              Documents
            </Link>
            <Link href="/search" className="kf-nav-link">
              Search
            </Link>
            <Link href="/capture" className="kf-nav-link">
              Capture
            </Link>
            <Link href="/agent" className="kf-nav-link">
              Agent
            </Link>
            <Link href="/ml/runs" className="kf-nav-link">
              ML runs
            </Link>
            <Link href="/status" className="kf-nav-link">
              Status
            </Link>
            <DensitySwitch density={density} />
            <Suspense fallback={<span className="kf-session-status">Identity…</span>}>
              <SessionStatus />
            </Suspense>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
