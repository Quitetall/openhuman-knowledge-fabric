import { getNeedsYou } from '../../lib/api/needs-you';
import { webCaller } from '../../lib/session';
import { NeedsYouPanel } from '../needs-you/needs-you-panel';

/**
 * THE NEEDS-YOU SLOT, filled. KF-WAR-0004 (M2) supplies the panel and its data — what an agent
 * submitted and waits on a person, what an agent proposed for them to perform, and the one-click
 * verify — and the dashboard (KF-WAR-0005, M3) owns only its PLACE: third in the one layout,
 * inside its own separated element (`NeedsYouPlace`).
 *
 * The data is the API's answer for this reader (`GET /needs-you`), which lists only what their
 * grants reach. Nothing here branches on who the reader is. When nothing needs them the slot
 * renders nothing, and its element collapses like any empty panel (`.kf-slot:empty`). Each
 * gesture returns to the dashboard (`returnTo="/"`), whose page shows the outcome.
 */
export async function NeedsYouSlot(): Promise<React.ReactNode> {
  const data = await getNeedsYou(await webCaller('/'));
  const waiting = data.toVerify.total + data.awaitingOthers.total + data.proposals.total;
  if (waiting === 0) return null;
  return (
    <section className="kf-panel" aria-labelledby="p-needs_you">
      <header className="kf-panel-header">
        <h2 id="p-needs_you" className="kf-panel-title">
          Needs you
        </h2>
        <p className="kf-panel-note">
          {waiting === 1 ? 'One item waits on you.' : `${String(waiting)} items wait on you.`}
        </p>
      </header>
      <NeedsYouPanel data={data} returnTo="/" headingLevel={3} />
    </section>
  );
}
