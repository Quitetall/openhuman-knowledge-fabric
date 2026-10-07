/**
 * The home screen: one dashboard for everyone, scoped by grants (ADR 0040 decision 2;
 * KF-SAS-RQ-262).
 *
 * The panels, their order and their contents are the API's answer for this reader
 * (`GET /dashboard`). This page renders them in the declared layout order and drops any panel the
 * API marks empty. It never reads a role or a job title: an owner, an engineer and a person with
 * one grant get this same component, and differ only in what the API returned to each.
 *
 * A signed-out visitor sees how to sign in, and the status report that used to be this page.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { loadWebIdentityConfig } from '../lib/auth';
import { getDashboard, type DashboardPanel } from '../lib/api/experience';
import { currentWebSession, webCaller } from '../lib/session';
import {
  ListPanel,
  MasterDocumentPanel,
  NeedsYouPlace,
  OverviewPanel,
  PeoplePanel,
} from './components/dashboard/panels';
import { StatusReport } from './components/status-report';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Home' };

function Panel({ panel }: { readonly panel: DashboardPanel }) {
  switch (panel.id) {
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
      return panel.empty ? null : <PeoplePanel assignments={panel.assignments} />;
  }
}

export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = loadWebIdentityConfig();
  if (identity.profile === 'dogfood' && (await currentWebSession()) === undefined) {
    return (
      <main className="kf-page kf-page-narrow">
        <section className="kf-signin">
          <h1 className="kf-title">Your record, as you are granted it</h1>
          <p>
            Sign in to see your dashboard: the organization overview, your master document, and the
            work and records your grants reach.
          </p>
          <p>
            <a href="/auth/login?next=/" className="kf-button kf-button-primary">
              Sign in
            </a>
          </p>
        </section>
        <StatusReport />
      </main>
    );
  }
  const dashboard = await getDashboard(await webCaller('/'));
  // The outcome of a Needs-you gesture, which returns here (`returnTo="/"`).
  const params = await searchParams;
  const done = typeof params['done'] === 'string' ? params['done'] : undefined;
  const refused = typeof params['refused'] === 'string' ? params['refused'] : undefined;
  return (
    <main className="kf-page kf-dashboard" data-layout={dashboard.layout.join(' ')}>
      <h1 className="kf-sr-only">Dashboard</h1>
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
      <p className="kf-footnote">
        <Link href="/status">Service status</Link>
      </p>
    </main>
  );
}
