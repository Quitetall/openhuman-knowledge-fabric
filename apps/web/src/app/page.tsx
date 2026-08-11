/**
 * Landing page.
 *
 * The real surfaces — project cockpit, work-order dossier, ADR log, configuration view,
 * finance subledger, quality traceability — arrive in Gates 5 and 6. Until they exist this
 * page states what is built rather than rendering an empty shell that looks operational.
 */

const GATES: { id: number; title: string; status: 'in progress' | 'not started' }[] = [
  { id: 1, title: 'Repository and development environment', status: 'in progress' },
  { id: 2, title: 'Ontology compiler', status: 'not started' },
  { id: 3, title: 'PostgreSQL authority kernel', status: 'not started' },
  { id: 4, title: 'Evidence vault and preservation', status: 'not started' },
  { id: 5, title: 'Work-control vertical slice', status: 'not started' },
  { id: 6, title: 'Product configuration and quality', status: 'not started' },
  { id: 7, title: 'Search, federation and agent APIs', status: 'not started' },
  { id: 8, title: 'Operational hardening', status: 'not started' },
];

export default function Home() {
  return (
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>OpenHuman Knowledge Fabric</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Institutional information platform — <code>OH-DOC-000002-1-R01</code>
      </p>

      <p
        style={{
          border: '1px solid #d4a72c',
          background: '#fff8e1',
          color: '#5c4300',
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
        }}
      >
        <strong>Not operational.</strong> No record in this system is authoritative until the
        authority kernel and its audit chain exist. Do not record work here yet.
      </p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Commissioning gates</h2>
      <ol style={{ paddingLeft: '1.25rem' }}>
        {GATES.map((gate) => (
          <li key={gate.id} style={{ marginBottom: '0.35rem' }}>
            {gate.title}{' '}
            <span style={{ color: gate.status === 'in progress' ? '#0a7' : '#999' }}>
              — {gate.status}
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}
