'use client';

import { startTransition, useActionState } from 'react';
import { captureNote } from './actions';
import { CaptureResult } from './capture-result';
import type { CaptureState } from './state';
import { VoiceNote } from './voice-note';

/**
 * One note, one gesture. The form asks for the note and, optionally, tags and what it is about;
 * it asks for no role, key or version (KF-SAS-RQ-200). The gesture id is hidden and changes only
 * after a note is recorded, so submitting twice replays rather than recording twice.
 *
 * At phone width the same form takes a photo (the camera, through the file input's `capture`) and
 * a voice note (recorded here), each attached to the observation as evidence (KF-SAS-RQ-273). The
 * classifications offered for them are the session's, at or below its ceiling, from the page.
 */
export function CaptureForm({
  gestureId,
  classifications,
  photoAccept,
  voiceAccept,
}: {
  readonly gestureId: string;
  readonly classifications: readonly string[];
  readonly photoAccept: string;
  readonly voiceAccept: string;
}) {
  const [state, action, pending] = useActionState<CaptureState, FormData>(captureNote, {
    status: 'idle',
    gestureId,
  });
  return (
    <>
      {/* Submitted by hand rather than through `action`: React resets a form after an action, so
          a refused note would lose its photo and recorded voice note while the page still showed
          them ready. A recorded note remounts the form (a new gesture id), which clears it. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(() => action(data));
        }}
        key={state.gestureId}
        style={{ display: 'grid', gap: '0.9rem', maxWidth: '52rem', marginTop: '1.5rem' }}
      >
        <input type="hidden" name="gestureId" value={state.gestureId} />
        <label>
          <span>What happened</span>
          <textarea
            name="body"
            rows={5}
            maxLength={65536}
            placeholder="Channel 3 noise floor 2.1 µV RMS at 250 Hz on board B."
            className="kf-control"
          />
        </label>
        <fieldset className="kf-capture-attachments">
          <legend>Photo and voice note (optional)</legend>
          <label className="kf-capture-media">
            <span>Photo</span>
            <input
              type="file"
              name="photo"
              accept={photoAccept}
              capture="environment"
              className="kf-control"
            />
          </label>
          <VoiceNote accept={voiceAccept} />
          {classifications.length === 0 ? null : (
            <label>
              <span>Classify the photo and voice note as</span>
              <select
                name="classification"
                className="kf-control"
                defaultValue={
                  classifications.includes('internal') ? 'internal' : classifications[0]
                }
              >
                {classifications.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="kf-footnote">
            Stored as evidence on this observation, up to 10 MiB together. Nothing is transcribed or
            analysed, and the media goes nowhere but the Fabric.
          </p>
        </fieldset>
        <label>
          <span>Tags (optional, comma-separated)</span>
          <input name="tags" className="kf-control" placeholder="bench, eeg-front-end" />
        </label>
        <label>
          <span>About (optional object ids)</span>
          <input name="subjects" className="kf-control" />
        </label>
        <button type="submit" className="kf-button" disabled={pending} aria-busy={pending}>
          {pending ? 'Recording…' : 'Record observation'}
        </button>
      </form>
      <CaptureResult state={state} />
    </>
  );
}
