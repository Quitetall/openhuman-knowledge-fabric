/**
 * The Object View's body: a projection Result rendered generically, the same for every object
 * type. Separate from the page so what it shows can be rendered and checked without a server.
 *
 * Whether each record has been verified is stated where the record appears — under the title
 * for the subject, beside each related record — because an unverified record that looks like
 * the checked ones around it borrows their credibility (KF-SAS-RQ-229).
 */

import { formatInstant, formatState } from '@kf/ui';
import type { ObjectView, ObjectViewMember } from '../../../lib/api';
import { Badge } from '../../components/badge';
import { VerificationNote } from '../../components/verification-note';

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

export function ObjectViewContent({ view }: { readonly view: ObjectView }) {
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
      <VerificationNote verification={subject.verification} />

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
                {other === undefined ? null : (
                  <VerificationNote verification={other.verification} />
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
