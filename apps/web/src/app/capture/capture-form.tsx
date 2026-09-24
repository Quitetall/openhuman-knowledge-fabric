'use client';

import { useActionState } from 'react';
import { captureNote } from './actions';
import { CaptureResult } from './capture-result';
import type { CaptureState } from './state';

/**
 * One note, one gesture. The form asks for the note and, optionally, tags and what it is about;
 * it asks for no role, key or version (KF-SAS-RQ-200). The gesture id is hidden and changes only
 * after a note is recorded, so submitting twice replays rather than recording twice.
 */
export function CaptureForm({ gestureId }: { readonly gestureId: string }) {
  const [state, action, pending] = useActionState<CaptureState, FormData>(captureNote, {
    status: 'idle',
    gestureId,
  });
  return (
    <>
      <form
        action={action}
        key={state.gestureId}
        style={{ display: 'grid', gap: '0.9rem', maxWidth: '52rem', marginTop: '1.5rem' }}
      >
        <input type="hidden" name="gestureId" value={state.gestureId} />
        <label>
          <span>What happened</span>
          <textarea
            name="body"
            required
            rows={5}
            maxLength={65536}
            placeholder="Channel 3 noise floor 2.1 µV RMS at 250 Hz on board B."
            className="kf-control"
          />
        </label>
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
