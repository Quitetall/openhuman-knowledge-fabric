/**
 * The master document: the reader's scope, compiled, read as one document (ADR 0040 decision 3;
 * KF-SAS-RQ-267).
 *
 * The living organization overview stands at its head when the reader's grants reach it; then one
 * section per record type of the compiled claim, a page at a time. The API re-reads every item
 * live, so a record whose grant was revoked after compiling is not shown here — only counted.
 * Compiling is an act, asked for with a button, never done by reading the page.
 */

import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getMasterDocument, type MasterDocumentSection } from '../../lib/api/experience';
import { webCaller } from '../../lib/session';
import { ClaimSummary, OverviewBody, RecordList } from '../components/dashboard/panels';
import { PendingButton } from '../components/pending-button';
import { compileNow } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Master document' };

const TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OUTCOME: Readonly<Record<string, string>> = {
  compiled: 'Compiled. This is your scope as it stands now.',
  unchanged: 'Nothing had changed: your existing compilation is current.',
  refused: 'The compilation was refused. Your context may have changed; sign in again.',
};

function Section({ section }: { readonly section: MasterDocumentSection }) {
  return (
    <section className="kf-doc-section" data-section={section.objectType}>
      <h2 className="kf-doc-heading">
        {section.title} <span className="kf-muted">({section.count.toLocaleString('en-GB')})</span>
      </h2>
      {section.items.length > 0 ? <RecordList records={section.items} /> : null}
      {section.noLongerInScope > 0 ? (
        <p className="kf-panel-note">
          {section.noLongerInScope === 1
            ? 'One record compiled here is no longer yours to read; it is not shown.'
            : `${String(section.noLongerInScope)} records compiled here are no longer yours to read; they are not shown.`}
        </p>
      ) : null}
      {section.next === null ? null : (
        <p className="kf-more">
          <Link
            href={`/master-document?type=${encodeURIComponent(section.objectType)}&after=${encodeURIComponent(section.next)}`}
          >
            Show more {section.title.toLowerCase()}
          </Link>
        </p>
      )}
    </section>
  );
}

export default async function MasterDocumentPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const type =
    typeof query['type'] === 'string' && TYPE.test(query['type']) ? query['type'] : undefined;
  const after =
    type !== undefined && typeof query['after'] === 'string' && UUID.test(query['after'])
      ? query['after']
      : undefined;
  const compiled = typeof query['compiled'] === 'string' ? OUTCOME[query['compiled']] : undefined;
  const caller = await webCaller('/master-document');
  const document = await getMasterDocument(caller, {
    ...(type === undefined ? {} : { type }),
    ...(after === undefined ? {} : { after }),
  });
  const key = `web-compile-${randomUUID()}`;
  return (
    <main className="kf-page kf-page-reading">
      <header className="kf-doc-header">
        <h1 className="kf-title">Your master document</h1>
        <p className="kf-lede">
          Everything you are granted in this organization, compiled into one record. Nothing else
          goes into it.
        </p>
        {compiled === undefined ? null : (
          <p role="status" className="kf-notice">
            {compiled}
          </p>
        )}
        <ClaimSummary claim={document.claim} />
        {document.claim.status === 'compiled' ? (
          <p className="kf-muted kf-digest">
            Corpus digest <code>{document.claim.corpusDigest.slice(0, 16)}</code>
          </p>
        ) : null}
        <form action={compileNow} className="kf-inline-form">
          <input type="hidden" name="idempotencyKey" value={key} />
          <PendingButton pendingLabel="Compiling…">Compile now</PendingButton>
        </form>
      </header>

      {type === undefined && document.overview !== null ? (
        <section className="kf-doc-overview" data-panel="overview" aria-labelledby="md-ov">
          <h2 id="md-ov" className="kf-doc-heading">
            {document.overview.title}
          </h2>
          <OverviewBody overview={document.overview} full={true} />
        </section>
      ) : null}

      {type === undefined ? null : (
        <p>
          <Link href="/master-document">Back to the whole document</Link>
        </p>
      )}
      {document.sections.map((section) => (
        <Section key={section.objectType} section={section} />
      ))}
    </main>
  );
}
