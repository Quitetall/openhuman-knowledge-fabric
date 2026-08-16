import type { DocumentWorkspace, SemanticChange } from '../../../lib/api';

function value(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function Change({ change }: { readonly change: SemanticChange }) {
  return (
    <li style={{ marginBottom: '0.6rem' }}>
      <code>{change.path}</code> — {change.kind}
      {'before' in change ? <div>Before: {value(change.before)}</div> : null}
      {'after' in change ? <div>After: {value(change.after)}</div> : null}
    </li>
  );
}

export function SemanticDiffPanel({ workspace }: { readonly workspace: DocumentWorkspace }) {
  if (workspace.status !== 'ready' || workspace.semanticDiff.status !== 'available') {
    return (
      <section>
        <h2>Semantic revision diff</h2>
        <p>No two succeeded exact-Basis semantic graphs are retained for comparison.</p>
      </section>
    );
  }
  const diff = workspace.semanticDiff;
  return (
    <section>
      <h2>Semantic revision diff</h2>
      <p>
        Run <code>{diff.fromRunId}</code> → <code>{diff.toRunId}</code>
      </p>
      {diff.changes.length === 0 ? (
        <p>No semantic graph changes.</p>
      ) : (
        <ol>
          {diff.changes.map((change, index) => (
            <Change key={`${change.path}:${change.kind}:${index}`} change={change} />
          ))}
        </ol>
      )}
      {diff.truncated ? (
        <p className="kf-status kf-status-warning">Diff exceeded the bounded projection limit.</p>
      ) : null}
    </section>
  );
}
