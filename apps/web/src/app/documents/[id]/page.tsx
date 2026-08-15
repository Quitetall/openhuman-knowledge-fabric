import { notFound } from 'next/navigation';
import { formatState } from '@kf/ui';
import { ApiError, get, type DocumentDetail } from '../../../lib/api';
import { webCaller } from '../../../lib/session';
import { ActionPanel } from '../../components/action-panel';
import { Badge } from '../../components/badge';
import { DocumentWorkbench } from './document-workbench';

export default async function DocumentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ refused?: string }>;
}) {
  const { id } = await params;
  const { refused } = await searchParams;
  const caller = await webCaller(`/documents/${id}`);
  let document: DocumentDetail;
  try {
    document = await get<DocumentDetail>(`/documents/${encodeURIComponent(id)}`, caller);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  // No typed document-to-training-run binding exists yet. Inventing one in UI would create a
  // second provenance model. Run metrics remain visible only from their authoritative run view.
  const metrics = { status: 'unbound' as const, metrics: [] as const };

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
      <section style={{ maxWidth: '52rem', marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Source provenance</h2>
        <p style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)' }}>
          {document.sha256 ?? 'unavailable'}
        </p>
      </section>

      <DocumentWorkbench document={document} metrics={metrics} />

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
          blockedActionTypes={[
            'approve_controlled_document',
            'make_document_effective',
            'accept_document_compilation',
            'publish_document_view',
          ]}
        />
      </section>
    </main>
  );
}
