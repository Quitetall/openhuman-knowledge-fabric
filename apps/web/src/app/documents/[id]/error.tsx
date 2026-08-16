'use client';

export default function DocumentError({
  retry,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly retry: () => void;
}) {
  return (
    <main style={{ maxWidth: '44rem', margin: '4rem auto', padding: '0 1.5rem' }}>
      <p style={{ color: '#64748b', margin: 0 }}>DOCUMENT WORKBENCH</p>
      <h1>Document unavailable</h1>
      <p>This document view could not be loaded. No error or record details are shown.</p>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={retry}>
          Try again
        </button>
        <a href="/documents">Return to documents</a>
      </div>
    </main>
  );
}
