import type { Metadata } from 'next';
import Link from 'next/link';
import { getStartHere } from '../../lib/api/qualification';
import { webCaller } from '../../lib/session';
import { StartHereView } from '../components/start-here';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Start Here' };

/**
 * `/start-here` — the signed-in person's qualification, as the protocol's five stages, generated
 * from their record (ADR 0038 decision 11; ADR 0040 decision 12; KF-SAS-RQ-275). An invited person
 * lands here after sign-in. Every person sees the same page; only what their pack places in each
 * stage differs.
 */
export default async function StartHerePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pages = await getStartHere(await webCaller('/start-here'));
  const params = await searchParams;
  const done = typeof params['done'] === 'string' ? params['done'] : undefined;
  const refused = typeof params['refused'] === 'string' ? params['refused'] : undefined;
  return (
    <main className="kf-page kf-page-reading">
      <h1 className="kf-title">Start Here</h1>
      <p className="kf-lede">
        Five stages, the same for everyone: what you have joined, your place in it, where the
        authoritative truth lives, how work moves here, and one bounded piece of real work. Your
        agent can explain any of it; a reviewer credits what you show.
      </p>
      {done === undefined ? null : (
        <p role="status" className="kf-notice">
          {done}
        </p>
      )}
      {refused === undefined ? null : (
        <p role="alert" className="kf-notice">
          Refused: {refused}
        </p>
      )}
      {pages.length === 0 ? (
        <p>
          Nothing to qualify for. <Link href="/">Your dashboard</Link>.
        </p>
      ) : (
        pages.map((page) => <StartHereView key={page.recordId} page={page} as="self" />)
      )}
    </main>
  );
}
