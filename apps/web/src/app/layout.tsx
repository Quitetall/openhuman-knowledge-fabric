import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Suspense } from 'react';
import { SessionStatus } from './components/session-status';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          lineHeight: 1.5,
        }}
      >
        <header style={{ borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
          <nav
            aria-label="Primary"
            className="kf-primary-nav"
            style={{
              maxWidth: '72rem',
              margin: '0 auto',
              padding: '0.9rem 1.5rem',
              display: 'flex',
              gap: '1.25rem',
              alignItems: 'center',
            }}
          >
            <Link href="/" style={{ color: '#111827', fontWeight: 700, textDecoration: 'none' }}>
              OpenHuman Knowledge Fabric
            </Link>
            <Link href="/documents" style={{ color: '#334155', textDecoration: 'none' }}>
              Documents
            </Link>
            <Link href="/search" style={{ color: '#334155', textDecoration: 'none' }}>
              Search
            </Link>
            <Link href="/ml/runs" style={{ color: '#334155', textDecoration: 'none' }}>
              ML runs
            </Link>
            <Suspense fallback={<span style={{ marginLeft: 'auto' }}>Identity…</span>}>
              <SessionStatus />
            </Suspense>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
