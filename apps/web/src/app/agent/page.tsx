import type { Metadata } from 'next';
import { webCaller } from '../../lib/session';
import { NoModelNotice } from '../components/no-model-notice';
import { AgentChat } from './agent-chat';
import { answeringModelConfigured } from './answer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ask' };

/**
 * `/agent` — the in-app agent on a page of its own (ADR 0040 decision 7). M3's dashboard hosts the
 * same chat through `AgentDock`. The page resolves the caller first, so a signed-out visitor signs
 * in before asking a question nobody could answer for them.
 */
export default async function AgentPage() {
  await webCaller('/agent');
  return (
    <main className="kf-page kf-page-narrow">
      <h1 className="kf-title">Ask</h1>
      <p className="kf-lede">
        Ask about anything you can see. Each answer lists its sources. Say “record that …” and it
        fills in the form for you to check; nothing is saved until you do.
      </p>
      {answeringModelConfigured() ? null : <NoModelNotice withResults={false} />}
      <AgentChat returnTo="/agent" />
    </main>
  );
}
