import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import {
  modeLabel,
  statusLabel,
  type Blocker,
  type RequirementStatus,
  type StartHere,
  type StartHereItem,
} from '../../lib/api/qualification';
import { acknowledgeRequirement, submitRequirementEvidence } from '../start-here/actions';

/**
 * Start Here: a person's qualification as the protocol's five stages (ADR 0038 decisions 1 and
 * 11; ADR 0040 decision 12; KF-SAS-RQ-275).
 *
 * It renders the API's generated page and nothing else: every status shown resolves to a
 * requirement and its evidence, and the digest at the foot is the page's own, so what a person
 * saw can be regenerated from the record and compared. Nothing here branches on a role or a
 * title — the five stages are the same for everyone, and only the requirements inside them differ.
 *
 * State is shown by form: a glyph, a word and a border style per status (decision 11), so it
 * reads the same in greyscale. Anything blocked says it is the organization's to fix, names the
 * contact, and never reads as the person's failure (RQ-261).
 *
 * `as="self"` offers the person's own gestures: acknowledging what is theirs to acknowledge, and
 * naming a record as evidence. `as="other"` is the same page for their contact, or for someone
 * who may credit it, who credits from Needs you.
 */

const GLYPH: Readonly<Record<RequirementStatus, string>> = {
  satisfied: '✓',
  open: '○',
  submitted: '◐',
  gap_revised: '△',
  blocked_on_organization: '⊘',
};

function StatusChip({ status }: { readonly status: RequirementStatus }) {
  return (
    <span className={`kf-chip kf-sh-status kf-sh-${status}`} data-status={status}>
      <span aria-hidden="true" className="kf-chip-glyph">
        {GLYPH[status]}
      </span>
      {statusLabel(status)}
    </span>
  );
}

function BlockerLine({
  blocker,
  contact,
}: {
  readonly blocker: Blocker;
  readonly contact: string;
}) {
  const what =
    blocker.kind === 'reviewer_unavailable'
      ? `nobody here can accept this evidence yet (${blocker.authority.replace(/^role:/, '')})`
      : blocker.kind === 'resource_missing'
        ? `a resource it needs (${blocker.resourceId.slice(0, 8)}) no longer exists`
        : `you are not yet granted a resource it needs (${blocker.resourceId.slice(0, 8)})`;
  return (
    <li data-blocker={blocker.kind}>
      Blocked on the organization: {what}. This is the organization’s to fix, not yours; {contact}{' '}
      has been named to help.
    </li>
  );
}

function Item({
  item,
  recordId,
  contact,
  person,
}: {
  readonly item: StartHereItem;
  readonly recordId: string;
  readonly contact: string;
  readonly person: boolean;
}) {
  const readable = item.resources.find((r) => r.reach === 'readable');
  const canAcknowledge =
    person &&
    item.mode === 'acknowledge' &&
    item.acceptedBy === 'self' &&
    (item.status === 'open' || item.status === 'gap_revised') &&
    readable !== undefined;
  const canSubmit =
    person &&
    item.mode !== 'acknowledge' &&
    (item.status === 'open' || item.status === 'gap_revised' || item.status === 'submitted');
  return (
    <li className="kf-sh-item" data-requirement={item.key} data-status={item.status}>
      <div className="kf-sh-item-head">
        <StatusChip status={item.status} />
        <span className="kf-sh-mode">{modeLabel(item.mode)}</span>
        {item.mandatory ? null : <span className="kf-sh-optional">optional</span>}
      </div>
      <p className="kf-sh-outcome">{item.outcome}</p>
      {item.consequence === null ? null : (
        <p className="kf-sh-consequence">
          <span className="kf-sh-label">Without it ({item.consequence.kind}):</span>{' '}
          {item.consequence.statement}
        </p>
      )}
      {item.resources.length === 0 ? null : (
        <ul className="kf-sh-resources">
          {item.resources.map((resource) => (
            <li key={resource.id} data-reach={resource.reach}>
              {resource.reach === 'readable' ? (
                <Link href={`/objects/${resource.id}`}>{resource.label ?? resource.id}</Link>
              ) : (
                <span>{resource.label ?? resource.id}</span>
              )}{' '}
              <span className="kf-muted">
                — {resource.authorityClass}, revision {resource.revision}
              </span>
            </li>
          ))}
        </ul>
      )}
      {item.blockers.length === 0 ? null : (
        <ul className="kf-sh-blockers">
          {item.blockers.map((blocker) => (
            <BlockerLine key={JSON.stringify(blocker)} blocker={blocker} contact={contact} />
          ))}
        </ul>
      )}
      {item.awaiting.length === 0 ? null : (
        <p className="kf-muted">After: {item.awaiting.join(', ')}</p>
      )}
      {item.evidence === null ? null : (
        <p className="kf-sh-evidence">
          {item.status === 'gap_revised'
            ? `Credited at revision ${String(item.evidence.revision)}; the requirement has since changed what it asks (revision ${String(item.revision)}).`
            : `Credited at revision ${String(item.evidence.revision)} on ${item.evidence.creditedAt.slice(0, 10)}`}
          {item.evidence.evidenceObjectId === null ? null : (
            <>
              {' '}
              — <Link href={`/objects/${item.evidence.evidenceObjectId}`}>the evidence</Link>
            </>
          )}
        </p>
      )}
      {item.submitted.length === 0 ? null : (
        <p className="kf-sh-evidence">
          Submitted: {item.submitted.map((s) => s.evidenceObjectId.slice(0, 8)).join(', ')} — a
          reviewer credits it from Needs you.
        </p>
      )}
      {canAcknowledge ? (
        <form action={acknowledgeRequirement} className="kf-inline-form">
          <input type="hidden" name="recordId" value={recordId} />
          <input type="hidden" name="requirementKey" value={item.key} />
          <input type="hidden" name="evidenceObjectId" value={readable.id} />
          <input type="hidden" name="idempotencyKey" value={`web-ack-${randomUUID()}`} />
          <button type="submit" className="kf-button">
            I have received and reviewed it
          </button>
        </form>
      ) : null}
      {canSubmit ? (
        <form action={submitRequirementEvidence} className="kf-sh-submit">
          <input type="hidden" name="recordId" value={recordId} />
          <input type="hidden" name="requirementKey" value={item.key} />
          <input type="hidden" name="idempotencyKey" value={`web-submit-${randomUUID()}`} />
          <label>
            The record that shows it (its id)
            <input
              name="evidenceObjectId"
              required
              pattern="[0-9a-fA-F-]{36}"
              className="kf-control"
              autoComplete="off"
            />
          </label>
          <button type="submit" className="kf-button">
            Submit as evidence
          </button>
        </form>
      ) : null}
    </li>
  );
}

export function StartHereView({
  page,
  as,
}: {
  readonly page: StartHere;
  readonly as: 'self' | 'other';
}) {
  const contact = page.contact.name ?? 'your named contact';
  const done = page.stages.reduce((n, s) => n + s.done, 0);
  const total = page.stages.reduce((n, s) => n + s.total, 0);
  return (
    <article className="kf-sh" data-record={page.recordId} data-currency={page.currency}>
      <header className="kf-sh-header">
        <h2 className="kf-panel-title">{page.pack.title}</h2>
        <p className="kf-panel-note">
          {page.scope.title === null ? null : <>For {page.scope.title}. </>}
          {as === 'self' ? 'Your contact' : 'Contact'}: {contact}. {done} of {total} done
          {page.blocked.length > 0
            ? `; ${String(page.blocked.length)} blocked on the organization`
            : ''}
          .
        </p>
        <p className="kf-sh-state" data-state={page.currency}>
          {page.currency === 'qualified'
            ? 'Qualified.'
            : page.currency === 'qualified_with_gap'
              ? `Qualified; a requirement has changed since (${page.gaps.join(', ')}), so only the acts it gates wait for it.`
              : page.currency === 'open'
                ? 'In progress. The stages are sections, not waiting rooms: start anywhere a prerequisite allows.'
                : `This record is ${page.currency}.`}
        </p>
      </header>
      {page.stages.map((stage) => (
        <section
          key={stage.id}
          className="kf-sh-stage"
          data-stage={stage.id}
          aria-labelledby={`sh-${page.recordId}-${stage.id}`}
        >
          <h3 id={`sh-${page.recordId}-${stage.id}`} className="kf-sh-stage-title">
            {stage.title}{' '}
            <span className="kf-muted">
              — {stage.question} ({stage.done} of {stage.total})
            </span>
          </h3>
          {stage.items.length === 0 ? (
            <p className="kf-muted">Nothing in this stage for this pack.</p>
          ) : (
            <ul className="kf-sh-items">
              {stage.items.map((item) => (
                <Item
                  key={item.key}
                  item={item}
                  recordId={page.recordId}
                  contact={contact}
                  person={as === 'self'}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      <p className="kf-footnote" data-digest={page.digest}>
        Generated from {as === 'self' ? 'your' : 'the'} record and pack revision{' '}
        {page.pack.revision}; never edited. Digest {page.digest.slice(0, 12)}.
      </p>
    </article>
  );
}
