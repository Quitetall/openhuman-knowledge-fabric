import { formatState } from '@kf/ui';
import type { DocumentWorkspace } from '../../../lib/api';
import { DigestDisclosure } from '../../components/digest-disclosure';

export function CompositionPanel({ workspace }: { readonly workspace: DocumentWorkspace }) {
  if (workspace.status !== 'ready') {
    return (
      <p className="kf-status kf-status-warning" role="status">
        Exact composition provenance requires one visible finalized Basis.
      </p>
    );
  }

  return (
    <div>
      <h2>Composition DAG</h2>
      <dl>
        <div>
          <dt style={{ color: '#64748b', fontSize: '0.78rem' }}>Root revision</dt>
          <dd style={{ margin: '0 0 0.75rem', overflowWrap: 'anywhere' }}>
            {workspace.composition.rootRevisionId || 'not a composition root'}
          </dd>
        </div>
      </dl>
      {workspace.composition.nodes.length === 0 ? (
        <p>No composition revisions are recorded for this Basis.</p>
      ) : (
        <div className="kf-table-scroll" tabIndex={0} aria-label="Composition revision table">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th align="left">Revision</th>
                <th align="left">Title</th>
                <th align="left">Stable key</th>
                <th align="left">Digest</th>
                <th align="left">Class</th>
              </tr>
            </thead>
            <tbody>
              {workspace.composition.nodes.map((node) => (
                <tr key={node.revisionId} style={{ borderTop: '1px solid #e2e8f0' }}>
                  <td style={{ overflowWrap: 'anywhere' }}>{node.revisionId}</td>
                  <td>{node.title}</td>
                  <td style={{ overflowWrap: 'anywhere' }}>{node.stableKey}</td>
                  <td>
                    <DigestDisclosure digest={node.revisionDigest} label="composition digest" />
                  </td>
                  <td>{formatState(node.classification)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Ordered inputs</h3>
      {workspace.composition.inputs.length === 0 ? (
        <p>No ordered composition inputs are recorded for this Basis.</p>
      ) : (
        <ol>
          {workspace.composition.inputs.map((input) => (
            <li key={`${input.compositionRevisionId}:${input.ordinal}`}>
              <strong>{formatState(input.role)}</strong> {input.targetTitle ?? input.targetId}{' '}
              <small style={{ color: '#64748b', overflowWrap: 'anywhere' }}>
                {input.targetId}
              </small>
              {input.contentDigest === null ? null : (
                <span>
                  {' '}
                  <DigestDisclosure digest={input.contentDigest} label="input digest" />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
