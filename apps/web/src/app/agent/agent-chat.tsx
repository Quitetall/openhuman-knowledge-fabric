'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { chat } from './actions';
import {
  EMPTY_CHAT,
  type AnswerEntry,
  type ChatCitation,
  type ChatState,
  type DraftEntry,
} from './state';

/**
 * The in-app agent's chat (ADR 0040 decision 7, KF-SAS-RQ-266, RQ-272, RQ-273).
 *
 * One column that reads at phone width: the conversation, then the question box. Every answer
 * shows the backend that produced it, the records it cites (each a link to the record) and how
 * many matching records the reader's grants do not reach. A request to record something shows the
 * act's real form — its own fields, labels and limits — and one button commits it.
 *
 * The conversation lives in this component's state only. Nothing is written to the browser's
 * storage and nothing is kept by the server; a reload starts a new conversation.
 */

export function AgentChat({
  returnTo = '/agent',
  compact = false,
}: {
  readonly returnTo?: string;
  readonly compact?: boolean;
}) {
  const [shown, action, pending] = useActionState<ChatState, FormData>(chat, EMPTY_CHAT);

  return (
    <section
      aria-label="Agent chat"
      className="kf-agent-chat"
      style={{ display: 'grid', gap: '0.9rem', minWidth: 0 }}
    >
      <ol
        aria-label="Conversation"
        aria-live="polite"
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.75rem' }}
      >
        {shown.entries.length === 0 ? (
          <li style={{ color: '#475569' }}>
            Ask about anything you can read, or say “record that …” to draft a record for one click.
          </li>
        ) : null}
        {shown.entries.map((entry, index) => {
          switch (entry.kind) {
            case 'question':
              return (
                <li key={index} className="kf-agent-question">
                  <strong>You:</strong> {entry.text}
                </li>
              );
            case 'answer':
              return (
                <li key={index}>
                  <Answer entry={entry} />
                </li>
              );
            case 'draft':
              return (
                <li key={index}>
                  <DraftForm entry={entry} returnTo={returnTo} action={action} pending={pending} />
                </li>
              );
            case 'outcome':
              return (
                <li
                  key={index}
                  role={entry.tone === 'error' ? 'alert' : 'status'}
                  className={`kf-status kf-status-${entry.tone}`}
                >
                  {entry.text}
                  {entry.recordIds === undefined || entry.recordIds.length === 0 ? null : (
                    <>
                      {' '}
                      {entry.recordIds.map((id) => (
                        <Link key={id} href={`/objects/${encodeURIComponent(id)}`}>
                          Open the record
                        </Link>
                      ))}
                    </>
                  )}
                </li>
              );
          }
        })}
      </ol>
      <form action={action} style={{ display: 'grid', gap: '0.5rem' }}>
        <input type="hidden" name="intent" value="ask" />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label>
          <span>{compact ? 'Ask the agent' : 'Ask, or say “record that …”'}</span>
          <textarea
            name="question"
            required
            rows={compact ? 2 : 3}
            maxLength={2000}
            className="kf-control"
            placeholder="What did the bench measure on the rail last week?"
          />
        </label>
        <button
          type="submit"
          className="kf-button kf-button-primary"
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? 'Working…' : 'Ask'}
        </button>
      </form>
    </section>
  );
}

function CitationLink({
  citation,
  guideRecordId,
}: {
  readonly citation: ChatCitation;
  /** The guide's record: its source is the person's Start Here, so it links there. */
  readonly guideRecordId?: string | undefined;
}) {
  const href =
    citation.recordId === guideRecordId
      ? `/qualification/${encodeURIComponent(citation.recordId)}`
      : `/objects/${encodeURIComponent(citation.recordId)}`;
  return (
    <>
      <Link href={href}>
        [{citation.n}] {citation.title}
      </Link>{' '}
      <span
        data-classification={citation.classification}
        style={{ fontSize: '0.8rem', color: '#475569' }}
      >
        ({citation.classification})
      </span>
    </>
  );
}

function Answer({ entry }: { readonly entry: AnswerEntry }) {
  return (
    <article
      className="kf-agent-answer"
      style={{
        borderLeft: '3px solid #94a3b8',
        paddingLeft: '0.75rem',
        display: 'grid',
        gap: '0.4rem',
      }}
    >
      {entry.text !== null ? (
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.text}</p>
      ) : entry.status === 'nothing_found' ? (
        <p style={{ margin: 0 }}>Nothing you can read answers this.</p>
      ) : null}
      {entry.refusal === undefined ? null : (
        <p role="alert" className="kf-status kf-status-warning" style={{ margin: 0 }}>
          {entry.refusal.message}
        </p>
      )}
      <p
        style={{ margin: 0, fontSize: '0.9rem', color: '#334155' }}
        data-backend={entry.backend?.kind ?? 'none'}
      >
        <strong>Answered by:</strong>{' '}
        {entry.backend === null
          ? 'no model (nothing was sent to one)'
          : `${entry.backend.name}${entry.backend.kind === 'on_host' ? ' — on this host' : ' — a provider’s model'}`}
      </p>
      {entry.guide === null ? null : (
        <p style={{ margin: 0, fontSize: '0.9rem', color: '#334155' }} data-testid="guided">
          <strong>Guided by:</strong> <Link href="/start-here">your Start Here</Link> (digest{' '}
          {entry.guide.digest.slice(0, 12)}). The guide explains and helps you submit evidence; it
          never credits or accepts anything.
        </p>
      )}
      {entry.citations.length === 0 ? null : (
        <div>
          <strong style={{ fontSize: '0.9rem' }}>Sources</strong>
          <ul aria-label="Sources" style={{ margin: '0.2rem 0 0', paddingLeft: '1.2rem' }}>
            {entry.citations.map((citation) => (
              <li key={citation.n}>
                <CitationLink citation={citation} guideRecordId={entry.guide?.recordId} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {entry.consulted.length > entry.citations.length ? (
        <details>
          <summary style={{ fontSize: '0.9rem' }}>
            Records read for this answer ({entry.consulted.length})
          </summary>
          <ul style={{ margin: '0.2rem 0 0', paddingLeft: '1.2rem' }}>
            {entry.consulted.map((citation) => (
              <li key={citation.n}>
                <CitationLink citation={citation} guideRecordId={entry.guide?.recordId} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p style={{ margin: 0, fontSize: '0.9rem', color: '#334155' }} data-testid="withheld">
        <strong>Withheld:</strong> {entry.withheldCount}{' '}
        {entry.withheldCount === 1 ? 'matching record' : 'matching records'} your grants do not
        reach.
      </p>
      {entry.notes.map((note, index) => (
        <p key={index} style={{ margin: 0, fontSize: '0.85rem', color: '#475569' }}>
          {note}
        </p>
      ))}
    </article>
  );
}

function DraftForm({
  entry,
  returnTo,
  action,
  pending,
}: {
  readonly entry: DraftEntry;
  readonly returnTo: string;
  readonly action: (form: FormData) => void;
  readonly pending: boolean;
}) {
  const settled = entry.settled !== undefined;
  return (
    <form
      action={action}
      aria-label={`Draft: ${entry.title}`}
      className="kf-agent-draft"
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: '0.5rem',
        padding: '0.75rem',
        display: 'grid',
        gap: '0.6rem',
        minWidth: 0,
      }}
    >
      <p style={{ margin: 0 }}>
        <strong>Draft — {entry.title}</strong>
        <br />
        <span style={{ fontSize: '0.9rem', color: '#475569' }}>
          {entry.description}{' '}
          {entry.filledBy === null
            ? 'Filled from your words as typed.'
            : `Filled by ${entry.filledBy.name}.`}{' '}
          Nothing is written until you {entry.disposition === 'propose' ? 'propose' : 'commit'} it.
        </span>
      </p>
      <input type="hidden" name="intent" value="commit" />
      <input type="hidden" name="act" value={entry.act} />
      <input type="hidden" name="gestureId" value={entry.gestureId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {entry.targets === 'one' ? (
        <label>
          <span>The {entry.targetKind ?? 'record'} it acts on (its id)</span>
          <input name="targetId" defaultValue={entry.targetId} className="kf-control" required />
        </label>
      ) : null}
      {entry.fields.map((field) => (
        <label key={field.name}>
          <span>
            {field.label}
            {field.required ? ' (required)' : ''}
          </span>
          {field.kind === 'text' && (field.maxLength ?? 0) > 240 ? (
            <textarea
              name={`field:${field.name}`}
              defaultValue={field.value}
              rows={3}
              maxLength={field.maxLength}
              required={field.required}
              className="kf-control"
            />
          ) : field.kind === 'classification' ? (
            <select name={`field:${field.name}`} defaultValue={field.value} className="kf-control">
              <option value="">The record kind’s default</option>
              <option value="public">public</option>
              <option value="internal">internal</option>
              <option value="confidential">confidential</option>
              <option value="restricted">restricted</option>
            </select>
          ) : (
            <input
              name={`field:${field.name}`}
              defaultValue={field.value}
              maxLength={field.maxLength}
              required={field.required}
              className="kf-control"
            />
          )}
          {field.problem === undefined ? null : (
            <span style={{ color: '#9a3412', fontSize: '0.85rem' }}>{field.problem}</span>
          )}
        </label>
      ))}
      {entry.reasonRequired ? (
        <label>
          <span>Why (required)</span>
          <textarea
            name="reason"
            defaultValue={entry.reason}
            rows={2}
            minLength={8}
            required
            className="kf-control"
          />
        </label>
      ) : null}
      <button
        type="submit"
        className="kf-button kf-button-primary"
        disabled={pending || settled}
        aria-busy={pending}
      >
        {settled
          ? entry.settled === 'proposed'
            ? 'Proposed'
            : 'Committed'
          : entry.disposition === 'propose'
            ? 'Propose — it waits in Needs you'
            : 'Commit this record'}
      </button>
    </form>
  );
}
