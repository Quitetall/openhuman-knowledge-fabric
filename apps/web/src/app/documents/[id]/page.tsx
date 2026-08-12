import { notFound } from 'next/navigation';
import { formatState, shortDigest } from '@kf/ui';
import { ApiError, get, type DocumentDetail } from '../../../lib/api';
import { developmentCaller } from '../../../lib/caller';
import { ActionPanel } from '../../components/action-panel';
import { Badge } from '../../components/badge';

function Atom({ atom }: { readonly atom: DocumentDetail['atoms'][number] }) {
  const id = `atom-${atom.ordinal}`;
  if (atom.kind === 'heading') {
    const style = { marginTop: '2rem', marginBottom: '0.5rem', scrollMarginTop: '1rem' };
    if ((atom.level ?? 2) <= 1)
      return (
        <h2 id={id} style={style}>
          {atom.text}
        </h2>
      );
    if (atom.level === 2)
      return (
        <h3 id={id} style={style}>
          {atom.text}
        </h3>
      );
    return (
      <h4 id={id} style={style}>
        {atom.text}
      </h4>
    );
  }
  if (atom.kind === 'paragraph') return <p id={id}>{atom.text}</p>;
  if (atom.kind === 'list_item') {
    return (
      <div
        id={id}
        style={{ paddingLeft: `${Math.max(1, atom.level ?? 1)}rem`, margin: '0.35rem 0' }}
      >
        • {atom.text}
      </div>
    );
  }
  if (atom.kind === 'quote') {
    return (
      <blockquote
        id={id}
        style={{
          borderLeft: '3px solid #94a3b8',
          marginLeft: 0,
          paddingLeft: '1rem',
          color: '#475569',
        }}
      >
        {atom.text}
      </blockquote>
    );
  }
  if (atom.kind === 'horizontal_rule')
    return <hr id={id} style={{ border: 0, borderTop: '1px solid #e2e8f0' }} />;
  return (
    <pre
      id={id}
      style={{
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        background: '#f8fafc',
        padding: '0.85rem',
        borderRadius: '0.4rem',
      }}
    >
      {atom.text}
    </pre>
  );
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ refused?: string }>;
}) {
  const { id } = await params;
  const { refused } = await searchParams;
  let document: DocumentDetail;
  try {
    document = await get<DocumentDetail>(
      `/documents/${encodeURIComponent(id)}`,
      developmentCaller(),
    );
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const headings = document.atoms.filter((atom) => atom.kind === 'heading');

  return (
    <main style={{ maxWidth: '76rem', margin: '0 auto', padding: '2.5rem 1.5rem 5rem' }}>
      <p style={{ color: '#64748b', margin: 0 }}>
        {document.documentNumber} · {document.revision}
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <h1 style={{ margin: '0.2rem 0', fontSize: '2rem' }}>{document.title}</h1>
        <Badge state={document.lifecycleState} />
      </div>
      <p style={{ color: '#475569', marginTop: '0.25rem' }}>
        {formatState(document.documentClass)} · owned by {formatState(document.owningRole)}
      </p>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 17rem',
          gap: '2rem',
          alignItems: 'start',
          marginTop: '2rem',
        }}
      >
        <article
          style={{
            minWidth: 0,
            fontFamily: 'ui-serif, Georgia, serif',
            fontSize: '1.04rem',
            lineHeight: 1.7,
          }}
        >
          {document.atoms.length === 0 ? (
            <p>No machine-parsed view is available for this source.</p>
          ) : (
            document.atoms.map((atom) => <Atom key={atom.ordinal} atom={atom} />)
          )}
        </article>
        <aside
          style={{
            border: '1px solid #e2e8f0',
            borderRadius: '0.65rem',
            padding: '1rem',
            fontSize: '0.85rem',
            position: 'sticky',
            top: '1rem',
          }}
        >
          <strong>Source integrity</strong>
          <dl style={{ marginBottom: '1rem' }}>
            <dt style={{ color: '#64748b' }}>SHA-256</dt>
            <dd style={{ marginLeft: 0, fontFamily: 'monospace' }}>
              {document.sha256 === null ? 'none' : shortDigest(document.sha256)}
            </dd>
            <dt style={{ color: '#64748b', marginTop: '0.4rem' }}>Parser</dt>
            <dd style={{ marginLeft: 0 }}>
              {document.parser ?? 'none'} {document.parserVersion ?? ''}
            </dd>
            <dt style={{ color: '#64748b', marginTop: '0.4rem' }}>Atoms</dt>
            <dd style={{ marginLeft: 0 }}>{document.atomCount}</dd>
          </dl>
          {headings.length === 0 ? null : (
            <>
              <strong>Contents</strong>
              <ol style={{ paddingLeft: '1.1rem' }}>
                {headings.map((heading) => (
                  <li key={heading.ordinal}>
                    <a href={`#atom-${heading.ordinal}`} style={{ color: '#334155' }}>
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ol>
            </>
          )}
        </aside>
      </section>

      <section style={{ maxWidth: '52rem', marginTop: '3rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Lifecycle</h2>
        {refused === undefined ? null : (
          <p style={{ padding: '0.75rem', background: '#fef2f2', color: '#991b1b' }}>
            <strong>Refused.</strong> {refused}
          </p>
        )}
        <ActionPanel
          objectId={document.id}
          path={`/documents/${document.id}`}
          state={document.lifecycleState}
          rowVersion={document.rowVersion}
        />
      </section>
    </main>
  );
}
