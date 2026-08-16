import type { DocumentWorkspace } from '../../../lib/api';
import { DigestDisclosure } from '../../components/digest-disclosure';

export function ProjectionDownloads({
  documentId,
  workspace,
}: {
  readonly documentId: string;
  readonly workspace: DocumentWorkspace;
}) {
  if (workspace.status !== 'ready') {
    return (
      <p className="kf-status kf-status-warning" role="status">
        Compiled preview downloads are withheld until exactly one finalized Basis maps to this
        source revision.
      </p>
    );
  }
  if (workspace.projections.length === 0) {
    return <p>No retained compiled projections exist for the latest exact-Basis run.</p>;
  }
  return (
    <section aria-label="Compiled projection downloads" style={{ marginBottom: '1.5rem' }}>
      <h2>Retained compiled projections</h2>
      <ul>
        {workspace.projections.map((projection) => (
          <li key={projection.id} style={{ marginBottom: '0.65rem' }}>
            <a
              href={`/documents/${encodeURIComponent(documentId)}/projections/${encodeURIComponent(projection.id)}`}
              className="kf-button"
            >
              Download {projection.target}
            </a>{' '}
            <small>
              {projection.mediaType} · {projection.effectiveClassification} ·{' '}
              <DigestDisclosure
                digest={projection.contentDigest}
                label={`${projection.target} projection digest`}
              />
            </small>
          </li>
        ))}
      </ul>
      <p style={{ color: '#64748b' }}>
        Each download rechecks the exact immutable storage version, recorded size, SHA-256 digest,
        caller classification, and Basis membership.
      </p>
    </section>
  );
}
