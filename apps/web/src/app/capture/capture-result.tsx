import Link from 'next/link';
import { formatState } from '@kf/ui';
import { VerificationNote } from '../components/verification-note';
import type { CaptureState } from './state';

/**
 * The answer to a capture, as the API gave it: recorded (or replayed), the observation's state,
 * and its verification label — `UNVERIFIED — nobody has checked this record` at capture, because
 * nobody has (SAS §48A). The label is the API's, parsed fail-closed; this page never writes one.
 */
export function CaptureResult({ state }: { readonly state: CaptureState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'refused') {
    return (
      <p role="alert" className="kf-status kf-status-error">
        Not recorded: {state.message}
      </p>
    );
  }
  const { outcome } = state;
  return (
    <section
      role="status"
      aria-live="polite"
      className="kf-status kf-status-success"
      data-observation={outcome.observationId}
    >
      <p style={{ margin: 0 }}>
        {outcome.replayed ? 'Already recorded — this was the same gesture.' : 'Recorded.'}{' '}
        <Link href={`/objects/${encodeURIComponent(outcome.observationId)}`}>
          Observation {outcome.observationId}
        </Link>{' '}
        is {formatState(outcome.lifecycleState)}.
      </p>
      <VerificationNote verification={outcome.verification} />
      {state.media === undefined ? null : (
        <ul className="kf-capture-attached">
          {state.media.map((m) => (
            <li key={m.artifactId} data-attached={m.kind}>
              {m.kind === 'photo' ? 'Photo' : 'Voice note'}{' '}
              <Link href={`/objects/${encodeURIComponent(m.artifactId)}`}>{m.artifactId}</Link>{' '}
              attached as evidence{m.replayed ? ' (already stored)' : ''}, not transcribed.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
