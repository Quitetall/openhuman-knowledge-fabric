/**
 * The project cockpit.
 *
 * What someone actually needs to see about a project: where it is in its lifecycle, what work
 * is under it, how much of that work has been ACCEPTED, and the full chain of who did what.
 *
 * Two things it deliberately does not do. It never shows a percentage it was not given — a
 * project with no packages reads as "no work packages yet", not "0%". And it renders no
 * editable field: every change on this page is a named action, because a form that PATCHes a
 * status is a form that moves a controlled record without an actor, a reason or an audit
 * event.
 */

import {
  get,
  ApiError,
  parseHistoryView,
  parseProjectView,
  type HistoryView,
  type ProjectView,
} from '../../../lib/api';
import type { Metadata } from 'next';
import { formatInstant, formatProgress, formatState } from '@kf/ui';
import { ActionPanel } from './action-panel';
import { webCaller } from '../../../lib/session';
import { Badge } from '../../components/badge';
import { DigestDisclosure } from '../../components/digest-disclosure';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Project ${id}` };
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ refused?: string }>;
}) {
  const { id } = await params;
  const { refused } = await searchParams;
  const caller = await webCaller(`/projects/${id}`);

  let project: ProjectView;
  let history: HistoryView;
  try {
    const encoded = encodeURIComponent(id);
    [project, history] = await Promise.all([
      get(`/projects/${encoded}`, caller, parseProjectView),
      get(`/objects/${encoded}/history`, caller, parseHistoryView),
    ]);
  } catch (err: unknown) {
    // A refusal is a fact about the record and is shown as one. A fault is our problem and
    // says only that — an error page that echoed a database message would leak table names
    // to whoever provoked it.
    const refusal = err instanceof ApiError && err.isRefusal;
    return (
      <main style={{ maxWidth: '52rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>{refusal ? 'Not available' : 'Something failed'}</h1>
        <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
          {refusal
            ? (err as ApiError).message
            : 'This page could not be loaded. The failure has been logged.'}
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: '52rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
      <p style={{ color: '#666', margin: 0, fontSize: '0.85rem' }}>
        {/* The enterprise identifier where one is allocated; §7.1 makes the UUID sufficient
            until then, so the fallback is the real id and not a placeholder. */}
        {project.project_code ?? project.enterprise_id ?? project.id}
      </p>
      <h1 style={{ fontSize: '1.5rem', margin: '0.25rem 0 0.5rem' }}>{project.title}</h1>
      <Badge state={project.lifecycle_state} />

      <p style={{ marginTop: '1rem' }}>{project.objective}</p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Progress</h2>
      <p style={{ margin: 0 }}>{formatProgress(project.progress)}</p>
      <p style={{ color: '#666', fontSize: '0.85rem', marginTop: '0.25rem' }}>
        Computed from accepted and waived work packages (KF-PROJ-001). Not from spending, not from
        elapsed time, and not from a number anyone typed.
      </p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Work packages</h2>
      {project.packages.length === 0 ? (
        <p style={{ color: '#666' }}>None yet.</p>
      ) : (
        <div className="kf-table-scroll" tabIndex={0} aria-label="Work packages table">
          <table aria-label="Work packages" style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th style={{ padding: '0.4rem 0.5rem 0.4rem 0', width: '3rem' }}>#</th>
                <th style={{ padding: '0.4rem 0.5rem' }}>Package</th>
                <th style={{ padding: '0.4rem 0.5rem' }}>State</th>
              </tr>
            </thead>
            <tbody>
              {project.packages.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>{p.sequence_no}</td>
                  <td style={{ padding: '0.4rem 0.5rem' }}>
                    {p.title}
                    <div style={{ color: '#666', fontSize: '0.8rem' }}>
                      {p.acceptance_criterion}
                    </div>
                  </td>
                  <td style={{ padding: '0.4rem 0.5rem' }}>
                    <Badge state={p.lifecycle_state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Actions</h2>
      {refused === undefined ? null : (
        <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
          {/* The last attempt was refused. Shown here rather than swallowed, because a form
              that appears to do nothing is indistinguishable from one that worked. */}
          <strong>Refused.</strong> {refused}
        </p>
      )}
      <ActionPanel
        objectId={project.id}
        path={`/projects/${project.id}`}
        state={project.lifecycle_state}
        rowVersion={project.row_version}
      />

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>History</h2>
      <p style={{ color: '#666', fontSize: '0.85rem', marginTop: 0 }}>
        Every controlled change, in order, with the digest that chains it to the one before.
      </p>
      <div className="kf-table-scroll" tabIndex={0} aria-label="Project history table">
        <table
          aria-label="Project history"
          style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9rem' }}
        >
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>When</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Action</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Actor</th>
              <th style={{ padding: '0.4rem 0.5rem' }}>Digest</th>
            </tr>
          </thead>
          <tbody>
            {history.events.map((e) => (
              <tr key={e.seq} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', whiteSpace: 'nowrap' }}>
                  {formatInstant(e.recorded_at)}
                </td>
                <td style={{ padding: '0.4rem 0.5rem' }}>
                  {formatState(e.action_type)}
                  {e.reason === null ? null : (
                    <div style={{ color: '#666', fontSize: '0.8rem' }}>{e.reason}</div>
                  )}
                </td>
                <td
                  style={{
                    padding: '0.4rem 0.5rem',
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: '0.8rem',
                  }}
                >
                  {e.actor_id.slice(0, 8)}
                </td>
                <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.8rem' }}>
                  <DigestDisclosure digest={e.digest} label={`event ${e.seq} digest`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
