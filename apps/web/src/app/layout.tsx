import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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
        {children}
      </body>
    </html>
  );
}
