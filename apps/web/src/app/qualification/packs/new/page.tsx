import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError } from '../../../../lib/api';
import { getPackDrafting } from '../../../../lib/api/qualification';
import { webCaller } from '../../../../lib/session';
import { PackForm } from './pack-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Draft a qualification pack' };

/**
 * `/qualification/packs/new` — draft a qualification pack (ADR 0038 decisions 3 to 5; SAS §24A,
 * §100.62). The form is offered only when the API answers that this reader may draft one, which
 * is the dispatcher's own preflight of `draft_qualification_pack` for them; otherwise the page
 * says so and offers nothing. A draft grants and assigns nothing. Approving it is
 * `approve_qualification_pack`, an institutional act this page does not perform.
 */
export default async function DraftPackPage() {
  const caller = await webCaller('/qualification/packs/new');
  let drafting;
  try {
    drafting = await getPackDrafting(caller);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) notFound();
    throw error;
  }
  return (
    <main className="kf-page kf-page-reading">
      <h1 className="kf-title">Draft a qualification pack</h1>
      <p className="kf-lede">
        A pack says what must be true before a person is ready for a scope: each requirement names
        its outcome, the evidence that counts and who may accept it. It references documents by id
        and revision and copies none. A role differs only in its pack.
      </p>
      {drafting.available ? (
        <PackForm
          gestureId={randomUUID()}
          roles={drafting.roles}
          parts={drafting.parts
            .filter((p) => !p.composesParts)
            .map((p) => `${p.key}@${String(p.revision)}`)}
        />
      ) : (
        <p role="status" className="kf-notice" data-gesture="none">
          You cannot draft a pack in the context you signed in with, so nothing here is offered.
        </p>
      )}
    </main>
  );
}
