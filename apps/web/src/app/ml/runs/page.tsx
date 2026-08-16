import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { isOpaqueReferenceToken } from '@kf/ml-registry/contracts';
import { webCaller } from '../../../lib/session';
import { PendingButton } from '../../components/pending-button';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Open ML run' };

export default async function MlRunsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  await webCaller('/ml/runs');
  const { error } = await searchParams;

  async function openRun(formData: FormData): Promise<void> {
    'use server';
    const authorityId = String(formData.get('authorityId') ?? '').trim();
    const revisionId = String(formData.get('revisionId') ?? '').trim();
    if (!isOpaqueReferenceToken(authorityId) || !isOpaqueReferenceToken(revisionId)) {
      redirect('/ml/runs?error=invalid');
    }
    // Validated opaque tokens contain only RFC 3986 path-segment characters; interpolating the
    // canonical value avoids handing an already escaped segment back through Next redirect.
    const route = `/ml/runs/${authorityId}/revisions/${revisionId}`;
    await webCaller(route);
    redirect(route);
  }

  return (
    <main style={{ maxWidth: '48rem', margin: '3rem auto', padding: '0 1.5rem' }}>
      <p style={{ color: '#64748b', fontSize: '0.8rem', letterSpacing: '0.04em' }}>
        PRIVACY-MINIMAL ML REGISTRY
      </p>
      <h1>Open training run</h1>
      <p>
        Metrics belong to immutable run lineage. Enter its external authority and revision
        references; internal registry identifiers are never exposed. Access remains scoped by
        selected organization and classification ceiling.
      </p>
      {error === undefined ? null : (
        <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
          Authority and revision must be valid opaque registry references.
        </p>
      )}
      <form action={openRun} style={{ display: 'grid', gap: '0.75rem' }}>
        <label>
          Run authority
          <input
            name="authorityId"
            aria-label="Run authority"
            required
            maxLength={128}
            placeholder="training-run:encoder-2026-08"
            className="kf-control"
          />
        </label>
        <label>
          Run revision
          <input
            name="revisionId"
            aria-label="Run revision"
            required
            maxLength={128}
            placeholder="r01"
            className="kf-control"
          />
        </label>
        <PendingButton pendingLabel="Opening run…" className="kf-button-primary">
          Open run
        </PendingButton>
      </form>
    </main>
  );
}
