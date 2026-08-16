import Link from 'next/link';
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addDocument,
  ApiError,
  get,
  parseDocumentsResponse,
  type DocumentSummary,
} from '../../lib/api';
import { webCaller } from '../../lib/session';
import { formatState } from '@kf/ui';
import { Badge } from '../components/badge';
import { PendingButton } from '../components/pending-button';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Documents' };

export default async function DocumentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ refused?: string }>;
}) {
  const caller = await webCaller('/documents');
  const { refused } = await searchParams;
  let documents: readonly DocumentSummary[] = [];
  let loadError: string | undefined;
  try {
    documents = (await get('/documents', caller, parseDocumentsResponse)).documents;
  } catch (error: unknown) {
    loadError = error instanceof ApiError ? error.message : 'Document library could not be loaded.';
  }

  async function importDocument(formData: FormData): Promise<void> {
    'use server';
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      redirect('/documents?refused=Choose+a+non-empty+document.');
    }
    if (file.size > 10 * 1024 * 1024) {
      redirect('/documents?refused=Document+exceeds+10+MiB+limit.');
    }
    try {
      const outcome = await addDocument(
        {
          title: String(formData.get('title')),
          documentNumber: String(formData.get('documentNumber')),
          revision: String(formData.get('revision')),
          documentClass: String(formData.get('documentClass')),
          owningRole: String(formData.get('owningRole')),
          fileName: file.name,
          mediaType: file.type || 'application/octet-stream',
          contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
          idempotencyKey: String(formData.get('idempotencyKey')),
        },
        await webCaller('/documents'),
      );
      revalidatePath('/documents');
      redirect(`/documents/${outcome.id}`);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.isRefusal) {
        redirect(`/documents?refused=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
  }

  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2.5rem 1.5rem 5rem' }}>
      <div style={{ maxWidth: '50rem' }}>
        <p style={{ color: '#64748b', margin: 0, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
          COMPOSED DOCUMENT SYSTEM
        </p>
        <h1 style={{ margin: '0.25rem 0 0.5rem', fontSize: '2rem' }}>Document library</h1>
        <p style={{ color: '#475569', marginTop: 0 }}>
          Verified source bytes, machine-parsed blocks, controlled lifecycle, one coherent view.
          Adding a document creates a draft. It does not approve or make anything effective.
        </p>
      </div>

      {refused === undefined ? null : (
        <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
          <strong>Not added.</strong> {refused}
        </p>
      )}
      {loadError === undefined ? null : (
        <p role="status" aria-live="polite" className="kf-status kf-status-warning">
          {loadError}
        </p>
      )}

      <section style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Constitution and controlled documents</h2>
        {loadError !== undefined ? null : documents.length === 0 ? (
          <p style={{ color: '#64748b' }}>No documents loaded yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {documents.map((document) => (
              <Link
                key={document.id}
                href={`/documents/${document.id}`}
                className="kf-document-row"
                style={{
                  gap: '1rem',
                  padding: '1rem 1.1rem',
                  border: '1px solid #e2e8f0',
                  borderRadius: '0.65rem',
                  color: 'inherit',
                  textDecoration: 'none',
                  background: '#fff',
                }}
              >
                <span>
                  <strong>{document.title}</strong>
                  <span style={{ display: 'block', color: '#64748b', fontSize: '0.85rem' }}>
                    {document.documentNumber} · {document.revision} ·{' '}
                    {formatState(document.documentClass)} · {document.parsedBlockCount} Parsed
                    Blocks
                  </span>
                </span>
                <Badge state={document.lifecycleState} />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section
        style={{
          marginTop: '3rem',
          maxWidth: '52rem',
          border: '1px solid #cbd5e1',
          borderRadius: '0.75rem',
          padding: '1.25rem',
          background: '#f8fafc',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Add draft document</h2>
        <form action={importDocument} style={{ display: 'grid', gap: '0.85rem' }}>
          <input
            type="hidden"
            name="idempotencyKey"
            value={`web-document-${crypto.randomUUID()}`}
          />
          <label>
            <span>Title</span>
            <input name="title" required maxLength={240} className="kf-control" />
          </label>
          <div className="kf-responsive-grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <label>
              <span>Document number</span>
              <input name="documentNumber" required className="kf-control" />
            </label>
            <label>
              <span>Revision</span>
              <input name="revision" required placeholder="R01" className="kf-control" />
            </label>
          </div>
          <div className="kf-responsive-grid">
            <label>
              <span>Class</span>
              <select name="documentClass" defaultValue="specification" className="kf-control">
                {[
                  'policy',
                  'procedure',
                  'work_instruction',
                  'form',
                  'record',
                  'specification',
                  'plan',
                  'report',
                ].map((value) => (
                  <option key={value} value={value}>
                    {formatState(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Owning role</span>
              <select name="owningRole" defaultValue="technical_authority" className="kf-control">
                {[
                  'technical_authority',
                  'quality_authority',
                  'configuration_authority',
                  'system_administrator',
                ].map((value) => (
                  <option key={value} value={value}>
                    {formatState(value)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Source file</span>
            <input
              name="file"
              type="file"
              required
              accept=".docx,.odt,.md,.markdown,.txt"
              className="kf-control"
            />
          </label>
          <PendingButton
            pendingLabel="Adding draft…"
            className="kf-button-primary"
            style={{ justifySelf: 'start' }}
          >
            Add draft
          </PendingButton>
        </form>
      </section>
    </main>
  );
}
