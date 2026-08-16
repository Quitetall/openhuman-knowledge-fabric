export function ProjectionFailure({ hidden }: { readonly hidden: boolean }) {
  return (
    <main style={{ maxWidth: '52rem', margin: '3rem auto', padding: '0 1.5rem' }}>
      <div role="alert" aria-live="assertive" className="kf-status kf-status-error">
        <h1>
          {hidden
            ? 'Run unavailable under selected authority context'
            : 'Run projection unavailable'}
        </h1>
        <p>
          {hidden
            ? 'The selected authority context cannot read this run, or the run does not exist.'
            : 'Projection failed closed; no partial lineage or metrics are shown.'}
        </p>
      </div>
    </main>
  );
}
