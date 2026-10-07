import type { Metadata } from 'next';
import { webCaller } from '../../lib/session';
import { AgentChat } from './agent-chat';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Agent' };

/**
 * `/agent` — the in-app agent on a page of its own (ADR 0040 decision 7). M3's dashboard hosts the
 * same chat through `AgentDock`. The page resolves the caller first, so a signed-out visitor signs
 * in before asking a question nobody could answer for them.
 */
export default async function AgentPage() {
  await webCaller('/agent');
  return (
    <main style={{ maxWidth: '52rem', margin: '0 auto', padding: '1.5rem 1rem 4rem' }}>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.75rem' }}>Agent</h1>
      <p style={{ color: '#475569', marginTop: 0 }}>
        Answers from the records you may read, citing each one and saying how many it could not show
        you. Confidential and restricted records are answered only on this host. Ask it to record
        something and it fills in the form; nothing is written until you commit it.
      </p>
      <AgentChat returnTo="/agent" />
    </main>
  );
}
