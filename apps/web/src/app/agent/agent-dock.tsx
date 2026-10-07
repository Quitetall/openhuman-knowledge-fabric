'use client';

import { AgentChat } from './agent-chat';

/**
 * The in-app agent as one panel another page can mount — M3's dashboard (KF-WAR-0005) — without
 * restyling it: a disclosure that holds the same chat as `/agent`, compact, full width of whatever
 * column it is placed in. `returnTo` is the hosting page's path, so a session that has to renew
 * comes back there.
 */
export function AgentDock({
  returnTo = '/',
  open = false,
}: {
  readonly returnTo?: string;
  readonly open?: boolean;
}) {
  return (
    <details open={open} className="kf-agent-dock" style={{ minWidth: 0 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Ask the agent</summary>
      <div style={{ marginTop: '0.75rem' }}>
        <AgentChat returnTo={returnTo} compact />
      </div>
    </details>
  );
}
