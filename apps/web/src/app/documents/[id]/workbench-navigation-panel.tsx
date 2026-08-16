import { formatState } from '@kf/ui';
import type { DocumentWorkspace, WorkspaceNavigationLink } from '../../../lib/api';

function LinkList({ links }: { readonly links: readonly WorkspaceNavigationLink[] }) {
  if (links.length === 0) return <p>No records visible.</p>;
  return (
    <ul>
      {links.map((link) => (
        <li key={link.id}>
          <strong>{formatState(link.relationType)}</strong> {link.direction} {link.peerTitle}{' '}
          <small style={{ color: '#64748b' }}>
            {link.peerObjectType} · {link.peerObjectId}
          </small>
        </li>
      ))}
    </ul>
  );
}

export function NavigationPanel({ workspace }: { readonly workspace: DocumentWorkspace }) {
  if (workspace.status !== 'ready') {
    return (
      <p className="kf-status kf-status-warning" role="status">
        Typed navigation requires one visible finalized Basis.
      </p>
    );
  }

  return (
    <div>
      <h2>Typed navigation</h2>
      <h3>Backlinks</h3>
      <LinkList links={workspace.navigation.backlinks} />
      <h3>Traceability</h3>
      <LinkList links={workspace.navigation.traceability} />
      <h3>ADR links</h3>
      {workspace.navigation.adr.length === 0 ? (
        <p>No ADR records visible.</p>
      ) : (
        <ul>
          {workspace.navigation.adr.map((adr) => (
            <li key={`${adr.decisionId}:${adr.topicKey ?? ''}`}>
              <strong>{adr.title}</strong>{' '}
              <small style={{ color: '#64748b' }}>
                {formatState(adr.lifecycleState)} · {adr.latestProgressKind ?? 'no progress'} ·{' '}
                {adr.topicKey ?? 'no topic'}
              </small>
            </li>
          ))}
        </ul>
      )}
      <h3>Topics</h3>
      {workspace.navigation.topics.length === 0 ? (
        <p>No topic records visible.</p>
      ) : (
        <ul>
          {workspace.navigation.topics.map((topic) => (
            <li key={`${topic.decisionId}:${topic.topicKey}`}>
              <strong>{topic.topicKey}</strong> {topic.title}{' '}
              <small style={{ color: '#64748b' }}>{formatState(topic.lifecycleState)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
