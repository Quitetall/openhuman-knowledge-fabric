import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'OpenHuman Knowledge Fabric',
  description: 'Institutional information platform — OH-DOC-000002-1-R01',
};

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
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
