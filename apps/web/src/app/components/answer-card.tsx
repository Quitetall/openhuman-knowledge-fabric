import Link from 'next/link';
import type { AnswerEntry } from '../agent/state';

/**
 * One answer, set for a person to read: the answer, then its sources as links, then how many
 * matching records were left out because the person may not see them (a count, never a title;
 * ADR 0037), then which model wrote it (ADR 0040 decision 8). A refusal keeps its rule code.
 */
export function AnswerCard({ entry }: { readonly entry: AnswerEntry }) {
  const withheld = entry.withheldCount;
  return (
    <article className="kf-answer" data-answer-status={entry.status}>
      <h2 className="kf-answer-heading">Answer</h2>
      {entry.text !== null ? (
        <p className="kf-answer-text">{entry.text}</p>
      ) : entry.status === 'nothing_found' ? (
        <p className="kf-answer-text">Nothing you can see answers this. Try other words.</p>
      ) : null}
      {entry.refusal === undefined ? null : (
        <p role="alert" className="kf-status kf-status-warning" data-refusal={entry.refusal.rule}>
          {entry.refusal.message} <span className="kf-code">({entry.refusal.rule})</span>
        </p>
      )}
      {entry.citations.length === 0 ? null : (
        <div className="kf-answer-sources">
          <h3 className="kf-answer-subheading">Sources</h3>
          <ol aria-label="Sources">
            {entry.citations.map((citation) => (
              <li key={citation.n} value={citation.n}>
                <Link href={`/objects/${encodeURIComponent(citation.recordId)}`}>
                  {citation.title}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
      {withheld === 0 ? null : (
        <p role="status" className="kf-status kf-status-neutral" data-withheld-count={withheld}>
          {withheld === 1
            ? '1 more matching record exists that you don’t have access to; it was not used.'
            : `${withheld} more matching records exist that you don’t have access to; they were not used.`}
        </p>
      )}
      <p className="kf-answer-backend" data-backend={entry.backend?.kind ?? 'none'}>
        {entry.backend === null
          ? 'No model wrote this; nothing was sent to one.'
          : entry.backend.kind === 'on_host'
            ? `Written by ${entry.backend.name}, running on this server.`
            : `Written by ${entry.backend.name}, an outside service, which may only see records like these.`}
      </p>
      {entry.notes.length === 0 ? null : (
        <details className="kf-explainer">
          <summary>More about this answer</summary>
          <ul>
            {entry.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      <p>
        <Link href="/agent">Ask a follow-up question</Link>
      </p>
    </article>
  );
}
