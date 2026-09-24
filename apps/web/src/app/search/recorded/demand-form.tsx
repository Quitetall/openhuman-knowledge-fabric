'use client';

import { useActionState } from 'react';
import { replayDemand } from './actions';
import { DemandResult } from './demand-result';
import type { DemandState } from './state';

/** The one demand replay button, and what it found. */
export function DemandForm() {
  const [state, action, pending] = useActionState<DemandState, FormData>(replayDemand, {
    status: 'idle',
  });
  return (
    <form action={action}>
      <button type="submit" className="kf-button" disabled={pending} aria-busy={pending}>
        {pending ? 'Replaying…' : 'Replay queries asked below my clearance'}
      </button>
      <DemandResult state={state} />
    </form>
  );
}
