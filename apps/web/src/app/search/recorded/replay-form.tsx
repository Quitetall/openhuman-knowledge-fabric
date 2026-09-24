'use client';

import { useActionState } from 'react';
import { replayOwnQuery } from './actions';
import { ReplayResult } from './replay-result';
import type { ReplayState } from './state';

/** One recorded query's replay button, and what the replay found. */
export function ReplayForm({ recordedQueryId }: { readonly recordedQueryId: string }) {
  const [state, action, pending] = useActionState<ReplayState, FormData>(replayOwnQuery, {
    status: 'idle',
  });
  return (
    <form action={action}>
      <input type="hidden" name="recordedQueryId" value={recordedQueryId} />
      <button type="submit" className="kf-button" disabled={pending} aria-busy={pending}>
        {pending ? 'Replaying…' : 'Replay at my clearance now'}
      </button>
      <ReplayResult state={state} />
    </form>
  );
}
