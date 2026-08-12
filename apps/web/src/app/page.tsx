/**
 * Landing page.
 *
 * States what is commissioned and what is not. The distinction is load-bearing: a page that
 * looks operational invites people to record work in a system that cannot yet keep it, and
 * one that under-claims sends them back to spreadsheets. Both are worse than saying plainly
 * which parts hold.
 */

type Status = 'commissioned';

const GATES: { id: number; title: string; status: Status; note?: string }[] = [
  { id: 1, title: 'Repository and development environment', status: 'commissioned' },
  { id: 2, title: 'Ontology compiler', status: 'commissioned' },
  { id: 3, title: 'PostgreSQL authority kernel', status: 'commissioned' },
  { id: 4, title: 'Evidence vault and preservation', status: 'commissioned' },
  { id: 5, title: 'Work-control vertical slice', status: 'commissioned' },
  { id: 6, title: 'Product configuration and quality', status: 'commissioned' },
  { id: 7, title: 'Search, federation and agent APIs', status: 'commissioned' },
  {
    id: 8,
    title: 'Operational hardening',
    status: 'commissioned',
    note: 'Deployment controls exist. This local interface remains explicit, non-authoritative dogfood until it uses a real identity provider.',
  },
];

const COLOUR: Record<Status, string> = {
  commissioned: '#0a7',
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
        <strong>Local dogfood, not an authoritative service.</strong> Commissioning gates are
        closed, but this interface still acts as a fixed development identity. Records created here
        prove composition and usability; they do not prove who performed an action.
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
        <li>
          Documents retain verified source bytes and compose machine-parsed, independently digested
          atoms into one readable view.
        </li>
      </ul>
    </main>
  );
}
