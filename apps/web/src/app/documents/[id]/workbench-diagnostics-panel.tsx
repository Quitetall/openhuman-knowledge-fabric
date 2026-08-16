import type { DocumentDetail, DocumentWorkspace } from '../../../lib/api';
import { DigestDisclosure } from '../../components/digest-disclosure';

export function DiagnosticsPanel({
  document,
  workspace,
}: {
  readonly document: DocumentDetail;
  readonly workspace: DocumentWorkspace;
}) {
  return (
    <div>
      <h2>Machine parsing diagnostics</h2>
      <p>
        <strong>Parser:</strong> {document.parser ?? 'none'} {document.parserVersion ?? ''}
      </p>
      <p>
        <strong>Materialized Parsed Blocks:</strong> {document.parsedBlockCount}
      </p>
      <p>
        <strong>Measured conversion losses:</strong> {document.conversionLoss.length}
      </p>
      {document.projectionContract === null ? (
        <p style={{ padding: '0.75rem', background: '#fff7ed', color: '#9a3412' }}>
          No measured parser projection contract is recorded.
        </p>
      ) : document.conversionLoss.length === 0 ? (
        <p style={{ padding: '0.75rem', background: '#ecfdf5', color: '#166534' }}>
          Parser reported no loss under {document.projectionContract}.
        </p>
      ) : (
        <div className="kf-table-scroll" tabIndex={0} aria-label="Conversion loss table">
          <table
            aria-label="Conversion loss"
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}
          >
            <thead>
              <tr>
                <th align="left">Code</th>
                <th align="left">Path</th>
                <th align="left">Detail</th>
                <th align="left">Source digest</th>
              </tr>
            </thead>
            <tbody>
              {document.conversionLoss.map((loss, index) => (
                <tr key={`${loss.path}:${loss.code}:${String(index)}`}>
                  <td>{loss.code}</td>
                  <td style={{ fontFamily: 'monospace' }}>{loss.path}</td>
                  <td>{loss.message}</td>
                  <td style={{ fontFamily: 'monospace' }}>
                    <DigestDisclosure
                      digest={loss.sourceDigest}
                      label={`conversion loss ${index + 1} source digest`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Exact-Basis compilation diagnostics</h2>
      {workspace.status !== 'ready' ? (
        <p className="kf-status kf-status-warning">
          Compilation evidence is withheld because the source does not resolve to one exact
          finalized Basis.
        </p>
      ) : workspace.compilation === null ? (
        <p>No compilation run is retained for Basis {workspace.basis.id}.</p>
      ) : (
        <>
          <p>
            <strong>Run:</strong> {workspace.compilation.runId} · {workspace.compilation.status} ·{' '}
            {workspace.compilation.draftOnly ? 'draft-only' : 'non-draft'}
          </p>
          <p>
            <strong>Semantic digest:</strong>{' '}
            {workspace.compilation.semanticDigest === null ? (
              'not recorded'
            ) : (
              <DigestDisclosure
                digest={workspace.compilation.semanticDigest}
                label="compilation semantic digest"
              />
            )}
          </p>
          {workspace.compilation.diagnostics.length === 0 ? (
            <p>No compiler diagnostics were recorded.</p>
          ) : (
            <ul>
              {workspace.compilation.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}:${index}`}>
                  <strong>{diagnostic.severity}</strong> · {diagnostic.code}: {diagnostic.message}
                </li>
              ))}
            </ul>
          )}
          <p>
            <strong>Compiler conversion losses:</strong>{' '}
            {workspace.compilation.conversionLoss.length}
          </p>
        </>
      )}
    </div>
  );
}
