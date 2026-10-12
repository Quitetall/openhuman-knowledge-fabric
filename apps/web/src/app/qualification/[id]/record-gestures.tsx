import type { RecordGestures } from '../../../lib/api/qualification';
import { PendingButton } from '../../components/pending-button';

/**
 * The institutional gestures this reader may perform on a qualification record, and only those
 * (ADR 0038; SAS §24A, §100.62). What is offered is the API's answer
 * (`kf-qualification-record-gestures-v1`, the dispatcher's own preflight for this reader): a
 * gesture the API did not offer is not rendered at all, not rendered disabled, and nothing here
 * reads a role. With nothing offered the component renders nothing.
 *
 * Each form asks for what its act needs and nothing else: a reason, which is recorded with the
 * act, and for a supersession the newer record in force that replaces this one.
 */
export function RecordGesturesView({
  gestures,
  gestureId,
  withdrawAction,
  supersedeAction,
}: {
  readonly gestures: RecordGestures;
  readonly gestureId: string;
  readonly withdrawAction: (form: FormData) => Promise<void>;
  readonly supersedeAction: (form: FormData) => Promise<void>;
}) {
  if (!gestures.withdraw && !gestures.supersede) return null;
  return (
    <section className="kf-panel kf-record-gestures" aria-labelledby="kf-record-gestures">
      <h2 id="kf-record-gestures" className="kf-panel-title">
        Withdraw or supersede
      </h2>
      <p className="kf-footnote">
        Institutional acts, recorded as yours with your reason. Withdrawing records why the record
        no longer stands; it is never recorded as missing evidence.
      </p>
      {gestures.withdraw ? (
        <form action={withdrawAction} className="kf-record-gesture" data-gesture="withdraw">
          <input type="hidden" name="recordId" value={gestures.recordId} />
          <input type="hidden" name="gestureId" value={`w-${gestureId}`} />
          <label>
            <span>Why it is withdrawn</span>
            <input className="kf-control" name="reason" required minLength={8} maxLength={2000} />
          </label>
          <PendingButton pendingLabel="Withdrawing…">Withdraw this qualification</PendingButton>
        </form>
      ) : null}
      {gestures.supersede ? (
        <form action={supersedeAction} className="kf-record-gesture" data-gesture="supersede">
          <input type="hidden" name="recordId" value={gestures.recordId} />
          <input type="hidden" name="gestureId" value={`s-${gestureId}`} />
          <label>
            <span>Superseded by</span>
            <select className="kf-control" name="supersededBy" required>
              {gestures.candidates.map((c) => (
                <option key={c.recordId} value={c.recordId}>
                  {c.pack.title}, revision {c.pack.revision}: {c.state}, assigned{' '}
                  {c.assignedAt.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>What the newer record is for</span>
            <input className="kf-control" name="reason" required minLength={8} maxLength={2000} />
          </label>
          <PendingButton pendingLabel="Superseding…">Supersede this qualification</PendingButton>
        </form>
      ) : null}
    </section>
  );
}
