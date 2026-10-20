/**
 * The home screen: the ask-or-search box first, then one dashboard for everyone, scoped by grants
 * (ADR 0040 decisions 2 and 7; KF-SAS-RQ-262).
 *
 * The box is a GET form back to this page, so a question is an address a person can share or
 * reload. It always searches; when this deployment has a model, "Ask" also answers from the record
 * through the same machinery as `/agent` (`agent/answer.ts`), citing what it used and saying how
 * many matching records the person may not see. Without a model it says so and shows the search.
 *
 * The panels, their order and their contents are the API's answer for this reader
 * (`GET /dashboard`). This page renders them in the declared layout order and drops any panel the
 * API marks empty. It never reads a role or a job title: an owner, an engineer and a person with
 * one grant get this same component, and differ only in what the API returned to each.
 *
 * A signed-out visitor sees one sentence and the way in; the status report is at /status.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { loadWebIdentityConfig } from '../lib/auth';
import { getSearchResults, type SearchResponse } from '../lib/api';
import { getDashboard, type DashboardPanel } from '../lib/api/experience';
import { backendsFor, loadAgentConfig } from '../lib/agent/config';
import { currentWebSession, webCaller } from '../lib/session';
import { providerCeiling } from '@kf/agent';
import {
  ListPanel,
  MasterDocumentPanel,
  NeedsYouPlace,
  OverviewPanel,
  PeoplePanel,
  StartHerePanel,
} from './components/dashboard/panels';
import { AnswerCard } from './components/answer-card';
import { AskBox } from './components/ask-box';
import { agentFabric, answerQuestion, answeringModelConfigured } from './agent/answer';
import type { AnswerEntry } from './agent/state';
import { SearchPreview } from './search/search-results';
import { searchByMeaning } from './search/search-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Home' };

function Panel({ panel }: { readonly panel: DashboardPanel }) {
  switch (panel.id) {
    case 'start_here':
      // Present only while the reader's own qualification is open (ADR 0040 decision 2).
      return panel.empty ? null : <StartHerePanel pages={panel.pages} />;
    case 'overview':
      return panel.empty || panel.overview === undefined ? null : (
        <OverviewPanel overview={panel.overview} />
      );
    case 'master_document':
      return <MasterDocumentPanel claim={panel.claim} />;
    case 'needs_you':
      return <NeedsYouPlace />;
    case 'work_in_flight':
      return panel.empty ? null : (
        <ListPanel
          id="work_in_flight"
          title="Work in flight"
          total={panel.total}
          records={panel.records}
          emptyOf="records still moving"
        />
      );
    case 'recent_record':
      return panel.empty ? null : (
        <ListPanel
          id="recent_record"
          title="Recent record"
          total={panel.total}
          records={panel.records}
          emptyOf="records you can read"
        />
      );
    case 'people':
      return panel.empty ? null : (
        <PeoplePanel assignments={panel.assignments} qualification={panel.qualification} />
      );
  }
}

type Asked =
  | { readonly kind: 'answer'; readonly entry: AnswerEntry }
  | { readonly kind: 'no_model' }
  | { readonly kind: 'failed' };

async function ask(question: string, returnTo: string): Promise<Asked> {
  if (!answeringModelConfigured()) return { kind: 'no_model' };
  try {
    const agent = await agentFabric(returnTo);
    const backends = backendsFor(loadAgentConfig(), () => providerCeiling(agent.fabric));
    return { kind: 'answer', entry: await answerQuestion({ ...agent, backends }, question) };
  } catch (error: unknown) {
    // A redirect to sign in again is Next's to perform, not an answer that failed.
    unstable_rethrow(error);
    return { kind: 'failed' };
  }
}

async function searchFor(
  caller: Awaited<ReturnType<typeof webCaller>>,
  text: string,
): Promise<SearchResponse | 'failed'> {
  try {
    return await getSearchResults(caller, { text, limit: 50 });
  } catch {
    return 'failed';
  }
}

function SignedOut() {
  return (
    <main className="kf-page kf-page-narrow">
      <section className="kf-landing">
        <h1 className="kf-title">Knowledge Fabric</h1>
        <p className="kf-lede">
          Your organization’s documents and records in one place: ask a question or search, and see
          only what you are allowed to see.
        </p>
        <p>
          <a href="/auth/login?next=/" className="kf-button kf-button-primary kf-button-large">
            Sign in
          </a>
        </p>
      </section>
    </main>
  );
}

export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = loadWebIdentityConfig();
  if (identity.profile === 'dogfood' && (await currentWebSession()) === undefined) {
    return <SignedOut />;
  }
  const params = await searchParams;
  const question = typeof params['q'] === 'string' ? params['q'].trim().slice(0, 512) : '';
  const mode = params['mode'] === 'ask' ? 'ask' : 'search';
  // Home reads its address leniently, as it does `q` and `mode`: a malformed switch is the default.
  const meaning = searchByMeaning(params['meaning']) ?? true;
  const returnTo =
    question === ''
      ? '/'
      : `/?${new URLSearchParams({ q: question, mode, ...(meaning ? {} : { meaning: 'off' }) }).toString()}`;
  const caller = await webCaller(returnTo);
  const canAsk = answeringModelConfigured();
  const [dashboard, results, asked] = await Promise.all([
    getDashboard(caller),
    question === '' ? Promise.resolve(undefined) : searchFor(caller, question),
    question === '' || mode !== 'ask' ? Promise.resolve(undefined) : ask(question, returnTo),
  ]);
  // The outcome of a Needs-you gesture, which returns here (`returnTo="/"`).
  const done = typeof params['done'] === 'string' ? params['done'] : undefined;
  const refused = typeof params['refused'] === 'string' ? params['refused'] : undefined;
  return (
    <main className="kf-page kf-home">
      <h1 className="kf-sr-only">Home</h1>
      <AskBox question={question} canAsk={canAsk} meaning={meaning} mode={mode} />
      {question === '' ? null : (
        <div className="kf-home-answer">
          {asked === undefined ? null : asked.kind === 'answer' ? (
            <AnswerCard entry={asked.entry} />
          ) : asked.kind === 'no_model' ? (
            <p role="status" className="kf-status kf-status-neutral" data-ask="no-model">
              Written answers aren’t set up on this server yet, so here are the records that match
              your words.
            </p>
          ) : (
            <p role="status" className="kf-status kf-status-warning" data-ask="failed">
              The assistant couldn’t answer just now. Here are the records that match your words.
            </p>
          )}
          {results === undefined ? null : results === 'failed' ? (
            <p role="status" className="kf-status kf-status-warning">
              Search isn’t working right now. Try again in a minute.
            </p>
          ) : (
            <SearchPreview response={results} query={question} meaning={meaning} />
          )}
        </div>
      )}
      <div className="kf-dashboard" data-layout={dashboard.layout.join(' ')}>
        {done === undefined ? null : (
          <p role="status" className="kf-notice kf-outcome">
            {done}
          </p>
        )}
        {refused === undefined ? null : (
          <p role="alert" className="kf-notice kf-outcome">
            Refused: {refused}
          </p>
        )}
        {dashboard.panels.map((panel) => (
          <Panel key={panel.id} panel={panel} />
        ))}
      </div>
      <p className="kf-footnote">
        <Link href="/status">Service status</Link>
      </p>
    </main>
  );
}
