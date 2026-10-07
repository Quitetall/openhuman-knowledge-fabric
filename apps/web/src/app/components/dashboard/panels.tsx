/**
 * The dashboard's panels (ADR 0040 decision 2; KF-SAS-RQ-262).
 *
 * Each renders exactly what the API returned for the signed-in reader and nothing else. None of
 * them is told who the reader is beyond the data: no role, no title, no condition on either. A
 * panel the API marks empty is not rendered at all (the page drops it); the Needs-you slot is
 * KF-WAR-0004's component in a separated element whose place the dashboard owns.
 */

import Link from 'next/link';
import {
  stateLabel,
  typeLabel,
  type ClaimHeader,
  type HeldAssignment,
  type OverviewReading,
  type OwnQualification,
  type RecordLine,
  type ReviewingQualification,
} from '../../../lib/api/experience';
import type { StartHere } from '../../../lib/api/qualification';
import { NeedsYouSlot } from '../needs-you-slot';
import { VerificationChip, WithheldChip } from '../state-chip';

const DATE = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE.format(date);
}

function withheldSentence(count: number): string {
  return count === 1
    ? 'One record you could be granted, and are not, is left out of this overview.'
    : `${String(count)} records you could be granted, and are not, are left out of this overview.`;
}

/** The overview as prose: one sentence per record, each a link to the record it is drawn from. */
export function OverviewBody({
  overview,
  full,
}: {
  readonly overview: OverviewReading;
  readonly full: boolean;
}) {
  return (
    <div className="kf-overview">
      {overview.sections.map((section) => (
        <section key={section.id} className="kf-overview-section" data-section={section.id}>
          <h3 className="kf-overview-heading">
            {section.title}
            {section.total > section.statements.length ? (
              <span className="kf-muted"> ({section.total})</span>
            ) : null}
          </h3>
          <ul className="kf-statements">
            {section.statements.map((statement) => (
              <li
                key={statement.objectId}
                className="kf-statement"
                data-record={statement.objectId}
              >
                <Link href={`/objects/${statement.objectId}`} className="kf-statement-text">
                  {statement.text}
                </Link>{' '}
                <VerificationChip verification={statement.verification} />
              </li>
            ))}
          </ul>
          {!full && section.total > section.statements.length ? (
            <p className="kf-more">
              <Link href="/master-document">
                {section.total - section.statements.length} more in your master document
              </Link>
            </p>
          ) : null}
        </section>
      ))}
      {overview.withheld > 0 ? (
        <p className="kf-withheld" data-withheld={overview.withheld}>
          <WithheldChip count={overview.withheld} /> {withheldSentence(overview.withheld)}
        </p>
      ) : null}
    </div>
  );
}

export function OverviewPanel({ overview }: { readonly overview: OverviewReading }) {
  return (
    <section className="kf-panel kf-panel-reading" data-panel="overview" aria-labelledby="p-ov">
      <header className="kf-panel-header">
        <h2 id="p-ov" className="kf-panel-title">
          {overview.title}
        </h2>
        <p className="kf-panel-note">
          Drawn from the {overview.statementCount} records you can read about the organization.{' '}
          <Link href={`/objects/${overview.overviewId}`}>The overview record</Link>
        </p>
      </header>
      <OverviewBody overview={overview} full={false} />
    </section>
  );
}

export function ClaimSummary({ claim }: { readonly claim: ClaimHeader }) {
  if (claim.status === 'missing') {
    return (
      <p>
        Your scope has not been compiled yet. Compiling it gathers every record you are granted into
        one document.
      </p>
    );
  }
  return (
    <dl className="kf-facts">
      <div>
        <dt>Compiled</dt>
        <dd>{formatDate(claim.compiledAt)}</dd>
      </div>
      <div>
        <dt>Records</dt>
        <dd data-record-count>{claim.memberCount.toLocaleString('en-GB')}</dd>
      </div>
      <div>
        <dt>Up to date</dt>
        <dd>
          {claim.currency === 'current'
            ? 'Yes — nothing it depends on has changed'
            : 'Not known — records may have changed since'}
        </dd>
      </div>
    </dl>
  );
}

export function MasterDocumentPanel({ claim }: { readonly claim: ClaimHeader }) {
  return (
    <section className="kf-panel" data-panel="master_document" aria-labelledby="p-md">
      <header className="kf-panel-header">
        <h2 id="p-md" className="kf-panel-title">
          Your master document
        </h2>
      </header>
      <ClaimSummary claim={claim} />
      <p>
        <Link href="/master-document" className="kf-link-strong">
          {claim.status === 'missing'
            ? 'Compile your master document'
            : 'Read your master document'}
        </Link>
      </p>
    </section>
  );
}

/** The slot's separated element. Empty, it collapses (`.kf-slot:empty`). */
export function NeedsYouPlace() {
  return (
    <div className="kf-slot" data-panel="needs_you" data-slot="needs-you">
      <NeedsYouSlot />
    </div>
  );
}

export function RecordList({ records }: { readonly records: readonly RecordLine[] }) {
  return (
    <ul className="kf-records">
      {records.map((line) => (
        <li key={line.id} className="kf-record" data-record={line.id}>
          <Link href={`/objects/${line.id}`} className="kf-record-title">
            {line.title}
          </Link>
          <span className="kf-record-meta">
            <span>{typeLabel(line.objectType)}</span>
            <span>{stateLabel(line.lifecycleState)}</span>
            {line.updatedAt === undefined ? null : (
              <time dateTime={line.updatedAt}>{formatDate(line.updatedAt)}</time>
            )}
          </span>
          <VerificationChip verification={line.verification} />
        </li>
      ))}
    </ul>
  );
}

export function ListPanel({
  id,
  title,
  total,
  records,
  emptyOf,
}: {
  readonly id: 'work_in_flight' | 'recent_record';
  readonly title: string;
  readonly total: number;
  readonly records: readonly RecordLine[];
  readonly emptyOf: string;
}) {
  return (
    <section className="kf-panel" data-panel={id} aria-labelledby={`p-${id}`}>
      <header className="kf-panel-header">
        <h2 id={`p-${id}`} className="kf-panel-title">
          {title}
        </h2>
        <p className="kf-panel-note">
          {total > records.length
            ? `The ${String(records.length)} most recent of ${total.toLocaleString('en-GB')} ${emptyOf}.`
            : `${String(total)} ${emptyOf}.`}
        </p>
      </header>
      <RecordList records={records} />
    </section>
  );
}

/**
 * Start Here, first while the reader's qualification is open (ADR 0040 decision 2). A summary:
 * each record's five stages as progress, and the way in. The page itself is `/start-here`.
 */
export function StartHerePanel({ pages }: { readonly pages: readonly StartHere[] }) {
  return (
    <section
      className="kf-panel kf-panel-reading"
      data-panel="start_here"
      aria-labelledby="p-start_here"
    >
      <header className="kf-panel-header">
        <h2 id="p-start_here" className="kf-panel-title">
          Start Here
        </h2>
        <p className="kf-panel-note">
          What you have joined, your place in it, where truth lives, how work moves, and one first
          piece of real work.
        </p>
      </header>
      {pages.map((page) => (
        <div key={page.recordId} className="kf-sh-summary" data-record={page.recordId}>
          <p className="kf-record-title">{page.pack.title}</p>
          <ol className="kf-sh-progress">
            {page.stages.map((stage) => (
              <li key={stage.id} data-stage={stage.id} data-complete={stage.done === stage.total}>
                <span aria-hidden="true">{stage.done === stage.total ? '✓' : '○'}</span>{' '}
                {stage.title}{' '}
                <span className="kf-muted">{`${String(stage.done)}/${String(stage.total)}`}</span>
              </li>
            ))}
          </ol>
          {page.blocked.length === 0 ? null : (
            <p className="kf-panel-note">
              {page.blocked.length === 1
                ? 'One item is blocked on the organization, not on you.'
                : `${String(page.blocked.length)} items are blocked on the organization, not on you.`}
            </p>
          )}
        </div>
      ))}
      <p>
        <Link href="/start-here" className="kf-button kf-button-primary">
          Open Start Here
        </Link>
      </p>
    </section>
  );
}

function QualificationLists({
  own,
  reviewing,
}: {
  readonly own: readonly OwnQualification[];
  readonly reviewing: readonly ReviewingQualification[];
}) {
  if (own.length === 0 && reviewing.length === 0) return null;
  return (
    <div className="kf-sh-people" data-part="qualification">
      {own.length === 0 ? null : (
        <>
          <h3 className="kf-sh-stage-title">Your qualification</h3>
          <ul className="kf-records">
            {own.map((q) => (
              <li key={q.recordId} className="kf-record" data-qualification={q.recordId}>
                <Link href="/start-here" className="kf-record-title">
                  {q.packTitle}
                </Link>
                <span className="kf-record-meta">
                  <span>
                    {q.currency === 'qualified'
                      ? 'qualified'
                      : q.currency === 'qualified_with_gap'
                        ? `qualified; changed since: ${q.gaps.join(', ')}`
                        : `${String(q.missing)} to do`}
                  </span>
                  {q.blocked === 0 ? null : <span>{q.blocked} blocked on the organization</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {reviewing.length === 0 ? null : (
        <>
          <h3 className="kf-sh-stage-title">People you guide or review</h3>
          <ul className="kf-records">
            {reviewing.map((q) => (
              <li key={q.id} className="kf-record" data-qualification={q.id}>
                <Link href={`/qualification/${q.id}`} className="kf-record-title">
                  {q.personName ?? 'A colleague'}
                </Link>
                <span className="kf-record-meta">
                  <span>{q.packTitle}</span>
                  <span>{q.state}</span>
                  {q.contact ? <span>you are their contact</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function PeoplePanel({
  assignments,
  qualification = { own: [], reviewing: [] },
}: {
  readonly assignments: readonly HeldAssignment[];
  readonly qualification?: {
    readonly own: readonly OwnQualification[];
    readonly reviewing: readonly ReviewingQualification[];
  };
}) {
  return (
    <section className="kf-panel" data-panel="people" aria-labelledby="p-people">
      <header className="kf-panel-header">
        <h2 id="p-people" className="kf-panel-title">
          People and qualification
        </h2>
        <p className="kf-panel-note">The roles you hold here, and the roles each one includes.</p>
      </header>
      <ul className="kf-records">
        {assignments.map((assignment) => (
          <li
            key={assignment.assignmentId}
            className="kf-record"
            data-record={assignment.assignmentId}
          >
            <Link href={`/objects/${assignment.assignmentId}`} className="kf-record-title">
              {typeLabel(assignment.roleId)}
            </Link>
            <span className="kf-record-meta">
              <span>{assignment.organizationWide ? 'whole organization' : 'one record'}</span>
              {assignment.validTo === null ? null : (
                <span>
                  until <time dateTime={assignment.validTo}>{formatDate(assignment.validTo)}</time>
                </span>
              )}
            </span>
            {assignment.reaches.filter((path) => path.length > 1).length > 0 ? (
              <span className="kf-paths">
                {assignment.reaches
                  .filter((path) => path.length > 1)
                  .map((path) => (
                    <span key={path.join('>')} className="kf-path">
                      {path.map(typeLabel).join(' includes ')}
                    </span>
                  ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <QualificationLists own={qualification.own} reviewing={qualification.reviewing} />
    </section>
  );
}
