/**
 * Landing page.
 *
 * States what is commissioned and what is not. The distinction is load-bearing: a page that
 * looks operational invites people to record work in a system that cannot yet keep it, and
 * one that under-claims sends them back to spreadsheets. Both are worse than saying plainly
 * which parts hold.
 */

import type { Metadata } from 'next';
import { loadWebIdentityConfig } from '../lib/auth';
import { getOperationalReadiness, type OperationalReadinessReport } from '../lib/api';
import { ReadinessPanel } from './components/readiness-panel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Overview' };

type Status = 'implemented' | 'open';
interface Gate {
  readonly id: number;
  readonly title: string;
  readonly status: Status;
  readonly note?: string;
}

const SERVICE_GATES: readonly Gate[] = [
  { id: 1, title: 'Repository and development environment', status: 'implemented' },
  { id: 2, title: 'Ontology compiler', status: 'implemented' },
  { id: 3, title: 'PostgreSQL authority kernel', status: 'implemented' },
  { id: 4, title: 'Evidence vault and preservation', status: 'implemented' },
  { id: 5, title: 'Work-control vertical slice', status: 'implemented' },
  { id: 6, title: 'Product configuration and quality', status: 'implemented' },
  { id: 7, title: 'Search, federation and agent APIs', status: 'implemented' },
  {
    id: 8,
    title: 'Operational hardening',
    status: 'implemented',
  },
  {
    id: 9,
    title: 'Controlled-document proposal mapping',
    status: 'implemented',
    note: 'The workbench exposes an exact authored-fragment revision and finalized Compilation Basis or fails closed; it records only typed proposals and never applies or approves them.',
  },
];

const COLOUR: Record<Status, string> = {
  implemented: '#047857',
  open: '#b45309',
};

const INSTITUTIONAL_GATES: readonly Omit<Gate, 'id'>[] = [
  {
    title: 'Liminal qualification',
    status: 'open',
    note: 'A qualified kf-document-v1 compiler and ratified HAQP evidence do not yet exist.',
  },
  {
    title: 'Identity provider and private-host commissioning',
    status: 'open',
    note: 'Real-provider policy, linked users and roles, TLS, host installation, restart and recovery evidence remain external operator work.',
  },
  {
    title: 'LamQuant compatibility and cutover',
    status: 'open',
    note: 'Pinned live import, zero-drift evidence, the 30-day shadow period and a human cutover decision remain outstanding.',
  },
  {
    title: 'Institutional authority actions',
    status: 'open',
    note: 'Controlled-document acceptance, publication and key custody, PHI admission, regulated model release and final cutover remain with named human authorities.',
  },
];

function statusLabel(status: Status): string {
  return status === 'open' ? 'open — blocked' : 'implemented';
}

export default async function Home() {
  const identity = loadWebIdentityConfig();
  let readiness: OperationalReadinessReport | undefined;
  let readinessError: string | undefined;
  const observedAt = new Date().toISOString();
  try {
    readiness = await getOperationalReadiness();
  } catch {
    readinessError = 'API readiness evidence is unavailable. Runtime state is unknown.';
  }
  const operationalNote =
    identity.profile === 'development'
      ? 'Deployment controls exist. This fixed-identity development profile is non-attributable and non-authoritative.'
      : 'Deployment controls exist. This dogfood profile uses OIDC bearer identity plus an API-validated KF authority context.';
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
        {identity.profile === 'development' ? (
          <>
            <strong>Fixed-identity development workspace.</strong> Records created here prove
            composition and usability; they do not prove who performed an action.
          </>
        ) : (
          <>
            <strong>Bearer-authenticated dogfood.</strong> Identity comes from OIDC; role,
            organization, and classification context remain explicit KF authority choices.
          </>
        )}
      </p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Implemented capability gates</h2>
      <p style={{ color: '#475569' }}>
        These report landed product capabilities. They do not assert current dependency health,
        grant institutional approval, or waive an external or human gate.
      </p>
      <ol style={{ paddingLeft: '1.25rem' }}>
        {SERVICE_GATES.map((gate) => (
          <li key={gate.id} style={{ marginBottom: '0.5rem' }}>
            {gate.title}{' '}
            <span style={{ color: COLOUR[gate.status] }}>— {statusLabel(gate.status)}</span>
            {gate.note === undefined && gate.id !== 8 ? null : (
              <div style={{ color: '#666', fontSize: '0.85rem' }}>
                {gate.id === 8 ? operationalNote : gate.note}
              </div>
            )}
          </li>
        ))}
      </ol>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Measured readiness evidence</h2>
      <p style={{ color: '#475569' }}>
        Evidence source: request-scoped <code>GET /readiness</code>, observed {observedAt}. Failed
        measurement stays unknown in its named partition; it never becomes a green empty state.
        Service verdict controls availability. Institutional verdict controls only governed
        operations.
      </p>
      {readiness === undefined ? (
        <p role="status" aria-live="polite" className="kf-status kf-status-neutral">
          <strong>Unknown.</strong> {readinessError}
        </p>
      ) : (
        <>
          <ReadinessPanel
            title="Measured service readiness"
            partition={readiness.service}
            readyLabel="Ready to serve shared dogfood."
            blockedLabel="Not ready to serve."
          />
          <ReadinessPanel
            title="Measured institutional readiness"
            partition={readiness.institutional}
            readyLabel="Recorded institutional evidence passes."
            blockedLabel="Governed operations remain blocked."
          />
        </>
      )}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>
        Known institutional gates outside runtime measurement
      </h2>
      <p style={{ color: '#475569' }}>
        These remain open even when a service capability is operational. Each blocks only the
        governed claim or action it protects.
      </p>
      <ul style={{ paddingLeft: '1.25rem' }}>
        {INSTITUTIONAL_GATES.map((gate) => (
          <li key={gate.title} style={{ marginBottom: '0.5rem' }}>
            {gate.title}{' '}
            <span style={{ color: COLOUR[gate.status] }}>— {statusLabel(gate.status)}</span>
            <div style={{ color: '#666', fontSize: '0.85rem' }}>{gate.note}</div>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>What holds today</h2>
      <ul style={{ paddingLeft: '1.25rem', color: '#333' }}>
        <li>
          Every controlled change goes through one named action, in one transaction, with an audit
          event chained to the one before it.
        </li>
        <li>
          Checkpoint service can sign audit-log coverage with a key API cannot read; measured
          institutional report shows whether current history is covered.
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
          Documents retain verified source bytes and expose machine-parsed, independently digested
          Parsed Blocks in one readable preview.
        </li>
      </ul>
    </main>
  );
}
