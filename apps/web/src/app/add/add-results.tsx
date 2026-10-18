import Link from 'next/link';
import type { AddOutcome } from './result';

/**
 * What happened to each file: added, with a link to its record, or not added, with the reason in
 * plain words and the API's code beside it so a refusal can still be looked up.
 */
export function AddResults({ outcomes }: { readonly outcomes: readonly AddOutcome[] }) {
  if (outcomes.length === 0) return null;
  const added = outcomes.filter((outcome) => outcome.status === 'added').length;
  const refused = outcomes.length - added;
  return (
    <section className="kf-add-results" aria-labelledby="add-results-heading">
      <h2 id="add-results-heading" className="kf-results-heading">
        {added === outcomes.length
          ? `${added === 1 ? 'File' : `All ${added} files`} added`
          : refused === outcomes.length
            ? `${refused === 1 ? 'The file was' : `None of the ${refused} files were`} added`
            : `${added} added, ${refused} not added`}
      </h2>
      <ul className="kf-add-list">
        {outcomes.map((outcome, index) =>
          outcome.status === 'added' ? (
            <li key={index} className="kf-add-item" data-add-status="added">
              <span className="kf-add-mark" aria-hidden="true">
                ✓
              </span>
              <span>
                <strong>{outcome.name}</strong> {outcome.replayed ? 'was already added.' : 'added.'}{' '}
                <Link href={`/objects/${encodeURIComponent(outcome.artifactId)}`}>Open it</Link>
                <span className="kf-muted"> · Not yet checked by anyone.</span>
              </span>
            </li>
          ) : (
            <li
              key={index}
              className="kf-add-item kf-add-refused"
              data-add-status="refused"
              data-refusal={outcome.code}
            >
              <span className="kf-add-mark" aria-hidden="true">
                ✕
              </span>
              <span>
                <strong>{outcome.name}</strong> was not added. {outcome.reason}{' '}
                <span className="kf-code">({outcome.code})</span>
              </span>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
