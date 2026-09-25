/**
 * The Object View — one page for every object type.
 *
 * It renders a projection Result: the record itself, then everything that touches it in
 * either direction, from the same engine that sections the master record. Nothing here is
 * type-specific; a new object type appears on this page the moment it is in the ontology.
 * History and available actions are facets read from the audit chain and the state machines.
 *
 * No editable field: every change is a named action elsewhere.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  get,
  ApiError,
  ARTIFACT_TEXT_LIMIT_BYTES,
  artifactDerivation,
  artifactFile,
  getArtifactText,
  isPlainText,
  parseObjectView,
  refreshObjectView,
  type Caller,
  type ObjectView,
} from '../../../lib/api';
import { webCaller } from '../../../lib/session';
import { loadObjectView } from './object-view-load';
import { ObjectViewContent } from './object-view-content';
import type { ArtifactPanelData, ArtifactTextOutcome } from './artifact-panel';

/**
 * The file panel for an artifact: its own retained version, the extraction pair around it, and
 * the text to show inline — the extracted text of an original, or a text artifact's own bytes.
 * The text is read through the API's source route as this viewer; a refusal there is shown as
 * a refusal, never papered over with the projection's metadata.
 */
async function artifactPanelData(view: ObjectView, caller: Caller): Promise<ArtifactPanelData> {
  const file = artifactFile(view.subject);
  const derivation = artifactDerivation(view);
  const textId =
    derivation.extractedTextId ??
    (file !== undefined && isPlainText(file.mediaType) ? view.subject.objectId : undefined);
  if (textId === undefined) return { derivation, ...(file === undefined ? {} : { file }) };
  let text: ArtifactTextOutcome;
  try {
    const read = await getArtifactText(textId, caller);
    text = { kind: 'shown', artifactId: textId, limitBytes: ARTIFACT_TEXT_LIMIT_BYTES, ...read };
  } catch (error: unknown) {
    text = {
      kind: 'unavailable',
      artifactId: textId,
      reason:
        error instanceof ApiError && error.isRefusal
          ? error.message
          : 'the API could not serve it just now.',
    };
  }
  return { derivation, text, ...(file === undefined ? {} : { file }) };
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Object ${id}` };
}

export default async function ObjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await webCaller(`/objects/${id}`);

  // A stale master record is refreshed without a click only when this request is the person's
  // own navigation (object-view-load.ts); a cross-site link still gets the button.
  const outcome = await loadObjectView(
    await headers(),
    () => get(`/objects/${encodeURIComponent(id)}`, caller, parseObjectView),
    () => refreshObjectView(id, caller),
  );
  if (outcome.kind === 'stale') {
    // Compiling the record is an act recorded as this person, so it happens only when they
    // ask: this request did not come from them, and a GET is what any site can send them to.
    async function refresh(): Promise<void> {
      'use server';
      await refreshObjectView(id, await webCaller(`/objects/${id}`));
      redirect(`/objects/${encodeURIComponent(id)}`);
    }
    return (
      <main style={{ maxWidth: '52rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>Your master record is out of date</h1>
        <p role="status" className="kf-status kf-status-neutral">
          Records you can see have changed since your master record was last compiled. Refreshing it
          is recorded as an action taken by you.
        </p>
        <form action={refresh}>
          <button type="submit">Refresh my master record and view this object</button>
        </form>
      </main>
    );
  }
  if (outcome.kind === 'failed') {
    const err = outcome.error;
    const refusal = err instanceof ApiError && err.isRefusal;
    return (
      <main style={{ maxWidth: '52rem', margin: '0 auto', padding: '3rem 1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>{refusal ? 'Not available' : 'Something failed'}</h1>
        <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
          {refusal
            ? (err as ApiError).message
            : 'This page could not be loaded. The failure has been logged.'}
        </p>
      </main>
    );
  }
  const view: ObjectView = outcome.view;
  const artifact =
    view.subject.objectType === 'artifact' ? await artifactPanelData(view, caller) : undefined;

  return <ObjectViewContent view={view} {...(artifact === undefined ? {} : { artifact })} />;
}
