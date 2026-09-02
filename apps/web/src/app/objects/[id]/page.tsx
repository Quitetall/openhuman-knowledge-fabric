/**
 * The Object View — one page for every object type.
 *
 * It renders a projection Result: the record itself, then everything that touches it in
 * either direction, from the same engine that sections the master record. Nothing here is
 * type-specific; a new object type appears on this page the moment it is in the ontology.
 * History and available actions are facets read from the audit chain and the state machines.
 *
 * No editable field: every change is a named action elsewhere.
 */

import type { Metadata } from 'next';
import {
  get,
  ApiError,
  parseObjectView,
  type ObjectView,
  type ObjectViewMember,
} from '../../../lib/api';
import { formatInstant, formatState } from '@kf/ui';
import { webCaller } from '../../../lib/session';
import { Badge } from '../../components/badge';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Object ${id}` };
}

/** Prominent fields: everything the typed payload carries, one row each, values as text. */
function payloadRows(member: ObjectViewMember): readonly { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  for (const [table, value] of Object.entries(member.content ?? {})) {
    if (table === 'core.object') continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      for (const [field, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
        if (field === 'id' || fieldValue === null || fieldValue === undefined) continue;
        rows.push({
          key: `${table}.${field}`,
          value: typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue),
        });
      }
    }
  }
  return rows;
}

export default async function ObjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await webCaller(`/objects/${id}`);

  let view: ObjectView;
  try {
    view = await get(`/objects/${encodeURIComponent(id)}`, caller, parseObjectView);
  } catch (err: unknown) {
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

  const { subject } = view;
  const byId = new Map(view.relationships.map((m) => [m.objectId, m]));
  const rows = payloadRows(subject);

  return (
    <main style={{ maxWidth: '52rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
      <p style={{ color: '#666', margin: 0, fontSize: '0.85rem' }}>
        {subject.objectType} · {subject.classification} · <code>{subject.objectId}</code>
      </p>
      <h1 style={{ fontSize: '1.5rem', margin: '0.25rem 0 0.5rem' }}>
        {subject.title ?? subject.objectType}
      </h1>
      {subject.lifecycleState === undefined ? null : <Badge state={subject.lifecycleState} />}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Overview</h2>
      {rows.length === 0 ? (
        <p style={{ color: '#666' }}>No typed fields visible.</p>
      ) : (
        <dl
          style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1rem' }}
        >
          {rows.map((row) => (
            <div key={row.key} style={{ display: 'contents' }}>
              <dt style={{ color: '#666', fontSize: '0.85rem' }}>{row.key}</dt>
              <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Relationships</h2>
      {view.edges.length === 0 ? (
        <p style={{ color: '#666' }}>Nothing links to or from this record.</p>
      ) : (
        <ul style={{ paddingLeft: '1.2rem' }}>
          {view.edges.map((edge) => {
            const outgoing = edge.sourceId === subject.objectId;
            const otherId = outgoing ? edge.targetId : edge.sourceId;
            const other = byId.get(otherId);
            return (
              <li key={`${edge.relationType}:${edge.sourceId}:${edge.targetId}`}>
                {outgoing ? '→' : '←'} <code>{edge.relationType}</code>{' '}
                <a href={`/objects/${encodeURIComponent(otherId)}`}>
                  {other?.title ?? other?.objectType ?? otherId}
                </a>
                {other === undefined ? null : (
                  <span style={{ color: '#666', fontSize: '0.85rem' }}> · {other.objectType}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Available actions</h2>
      {view.availableActions.length === 0 ? (
        <p style={{ color: '#666' }}>None from this state.</p>
      ) : (
        <ul style={{ paddingLeft: '1.2rem' }}>
          {view.availableActions.map((action) => (
            <li key={action.actionType}>
              <code>{action.actionType}</code>
              {action.toStates.length > 0
                ? ` → ${action.toStates.map(formatState).join(' | ')}`
                : ''}
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>History</h2>
      {view.history.length === 0 ? (
        <p style={{ color: '#666' }}>No recorded actions.</p>
      ) : (
        <ol style={{ paddingLeft: '1.2rem' }}>
          {view.history.map((event) => (
            <li key={event.seq}>
              <code>{event.action_type}</code> · {formatInstant(event.recorded_at)}
              {event.reason === null ? null : (
                <span style={{ color: '#666', fontSize: '0.85rem' }}> — {event.reason}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      <p style={{ color: '#666', fontSize: '0.8rem', marginTop: '2rem' }}>
        Projection <code>{view.projectionDigest.slice(0, 12)}</code> over corpus{' '}
        <code>{view.corpusDigest.slice(0, 12)}</code>
      </p>
    </main>
  );
}
