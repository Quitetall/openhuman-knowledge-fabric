import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '../../../lib/api';
import {
  getQualificationRecord,
  getRecordGestures,
  type RecordGestures,
} from '../../../lib/api/qualification';
import { webCaller } from '../../../lib/session';
import { StartHereView } from '../../components/start-here';
import { supersedeQualification, withdrawQualification } from './actions';
import { RecordGesturesView } from './record-gestures';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Qualification' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `/qualification/<id>` — someone's Start Here, for their contact or a reviewer (ADR 0038
 * decision 12). The API answers it only for those; for anyone else this is a 404, the same as for
 * a record that does not exist. Credits are given from Needs you, where submitted evidence waits.
 *
 * Withdrawing and superseding the record are offered below it to a reader the API says may
 * perform them (`GET /qualification/records/:id/gestures`), and to nobody else (§100.62). When that
 * answer cannot be had, nothing is offered: the page fails toward offering less.
 */
export default async function QualificationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const done = typeof query['done'] === 'string' ? query['done'] : undefined;
  const refused = typeof query['refused'] === 'string' ? query['refused'] : undefined;
  if (!UUID.test(id)) notFound();
  const caller = await webCaller(`/qualification/${id}`);
  let page;
  try {
    page = await getQualificationRecord(caller, id);
  } catch (error: unknown) {
    if (error instanceof ApiError) notFound();
    throw error;
  }
  let gestures: RecordGestures | undefined;
  try {
    gestures = await getRecordGestures(caller, id);
  } catch (error: unknown) {
    if (!(error instanceof ApiError)) throw error;
    gestures = undefined;
  }
  return (
    <main className="kf-page kf-page-reading">
      <h1 className="kf-title">Qualification</h1>
      <p className="kf-lede">
        As the person sees it. Evidence they submit waits in{' '}
        <Link href="/needs-you">Needs you</Link>, where crediting it accepts the work in the same
        gesture.
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
      <StartHereView page={page} as="other" />
      {gestures === undefined ? null : (
        <RecordGesturesView
          gestures={gestures}
          gestureId={randomUUID()}
          withdrawAction={withdrawQualification}
          supersedeAction={supersedeQualification}
        />
      )}
    </main>
  );
}
