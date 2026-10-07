import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '../../../lib/api';
import { getQualificationRecord } from '../../../lib/api/qualification';
import { webCaller } from '../../../lib/session';
import { StartHereView } from '../../components/start-here';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Qualification' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `/qualification/<id>` — someone's Start Here, for their contact or a reviewer (ADR 0038
 * decision 12). The API answers it only for those; for anyone else this is a 404, the same as for
 * a record that does not exist. Credits are given from Needs you, where submitted evidence waits.
 */
export default async function QualificationPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const caller = await webCaller(`/qualification/${id}`);
  let page;
  try {
    page = await getQualificationRecord(caller, id);
  } catch (error: unknown) {
    if (error instanceof ApiError) notFound();
    throw error;
  }
  return (
    <main className="kf-page kf-page-reading">
      <h1 className="kf-title">Qualification</h1>
      <p className="kf-lede">
        As the person sees it. Evidence they submit waits in{' '}
        <Link href="/needs-you">Needs you</Link>, where crediting it accepts the work in the same
        gesture.
      </p>
      <StartHereView page={page} as="other" />
    </main>
  );
}
