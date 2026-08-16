export function DetailLoading({ label }: { readonly label: string }) {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      style={{ maxWidth: '52rem', margin: '3rem auto', padding: '0 1.5rem' }}
    >
      <p style={{ color: '#64748b', letterSpacing: '0.04em', fontSize: '0.8rem' }}>LOADING</p>
      <h1 style={{ fontSize: '1.4rem' }}>{label}</h1>
      <p role="status">Retrieving the caller-scoped detail view…</p>
    </main>
  );
}
