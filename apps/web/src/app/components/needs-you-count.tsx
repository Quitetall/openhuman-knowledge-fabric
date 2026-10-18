import { getNeedsYou } from '../../lib/api/needs-you';
import { establishedCaller } from '../../lib/session';

/**
 * The number beside "Needs you" in the navigation: what waits on this person — records to verify,
 * acts their agent proposed, evidence to credit — as `GET /needs-you` counts it for them. Nothing
 * when nothing waits, when no context is chosen yet, or when the API cannot say: a count is a
 * convenience, and the page itself is one click away.
 */
export async function NeedsYouCount() {
  const caller = await establishedCaller();
  if (caller === undefined) return null;
  let waiting: number;
  try {
    const data = await getNeedsYou(caller);
    waiting = data.toVerify.total + data.proposals.total + data.toCredit.total;
  } catch {
    return null;
  }
  if (waiting === 0) return null;
  return (
    <span className="kf-count" data-needs-you-count={waiting}>
      <span className="kf-sr-only">, </span>
      {waiting > 99 ? '99+' : String(waiting)}
      <span className="kf-sr-only"> waiting</span>
    </span>
  );
}
