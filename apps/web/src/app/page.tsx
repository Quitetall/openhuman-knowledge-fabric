/**
 * Landing page.
 *
 * States what is commissioned and what is not. The distinction is load-bearing: a page that
 * looks operational invites people to record work in a system that cannot yet keep it, and
 * one that under-claims sends them back to spreadsheets. Both are worse than saying plainly
 * which parts hold.
 */

type Status = 'commissioned' | 'in progress' | 'not started';

const GATES: { id: number; title: string; status: Status; note?: string }[] = [
  { id: 1, title: 'Repository and development environment', status: 'commissioned' },
  { id: 2, title: 'Ontology compiler', status: 'commissioned' },
  { id: 3, title: 'PostgreSQL authority kernel', status: 'commissioned' },
  { id: 4, title: 'Evidence vault and preservation', status: 'commissioned' },
  {
    id: 5,
    title: 'Work-control vertical slice',
    status: 'in progress',
    note: 'Project to closure runs end to end through actions; this interface is the last piece.',
  },
  { id: 6, title: 'Product configuration and quality', status: 'not started' },
  { id: 7, title: 'Search, federation and agent APIs', status: 'not started' },
  {
    id: 8,
    title: 'Operational hardening',
    status: 'in progress',
    note: 'The API verifies OIDC bearer tokens and refuses to boot outside development without a provider. This web application still acts as a fixed development identity and refuses to run outside development.',
  },
];

const COLOUR: Record<Status, string> = {
  commissioned: '#0a7',
  'in progress': '#b45309',
  'not started': '#999',
};

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
        <strong>Not yet in service.</strong> The authority kernel, its audit chain and the
        preservation export all hold, work control runs end to end, and the API verifies OIDC bearer
        tokens against a provider. This web application does not yet — it still acts as a fixed
        development identity, so anything recorded through THIS interface cannot be relied on as a
        record of who did it.
      </p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Commissioning gates</h2>
      <ol style={{ paddingLeft: '1.25rem' }}>
        {GATES.map((gate) => (
          <li key={gate.id} style={{ marginBottom: '0.5rem' }}>
            {gate.title} <span style={{ color: COLOUR[gate.status] }}>— {gate.status}</span>
            {gate.note === undefined ? null : (
              <div style={{ color: '#666', fontSize: '0.85rem' }}>{gate.note}</div>
            )}
          </li>
        ))}
      </ol>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>What holds today</h2>
      <ul style={{ paddingLeft: '1.25rem', color: '#333' }}>
        <li>
          Every controlled change goes through one named action, in one transaction, with an audit
          event chained to the one before it.
        </li>
        <li>
          The audit log is checkpointed with a signature the API cannot forge, so a rewrite is
          detectable by anyone holding only a public key.
        </li>
        <li>
          The canonical export round-trips through an empty database byte for byte, which is what
          makes the database replaceable rather than load-bearing.
        </li>
        <li>
          All ten R01 invariants are enforced — as database constraints, action preconditions, or
          both.
        </li>
      </ul>
    </main>
  );
}
