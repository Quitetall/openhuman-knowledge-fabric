/**
 * Home's one box: ask a question or search, the first thing on the page.
 *
 * A plain GET form back to Home, so it works without script and a question is an address. "Ask"
 * is offered only when this deployment has a model to answer with; "Search" always is. Pressing
 * Enter uses the first button, so Enter asks when asking is possible and searches otherwise.
 */
export function AskBox({
  question,
  canAsk,
}: {
  readonly question: string;
  readonly canAsk: boolean;
}) {
  return (
    <section className="kf-askbox" aria-labelledby="askbox-heading">
      <h2 id="askbox-heading" className="kf-askbox-heading">
        Ask or search your records
      </h2>
      <form action="/" method="get" role="search" className="kf-askbox-form">
        <label htmlFor="askbox-q" className="kf-sr-only">
          Your question or search words
        </label>
        <input
          id="askbox-q"
          type="search"
          name="q"
          required
          maxLength={512}
          defaultValue={question}
          placeholder={
            canAsk
              ? 'For example: what changed in the last calibration procedure?'
              : 'For example: calibration procedure'
          }
          className="kf-control kf-control-large"
          autoComplete="off"
        />
        <div className="kf-askbox-actions">
          {canAsk ? (
            <button
              type="submit"
              name="mode"
              value="ask"
              className="kf-button kf-button-primary kf-button-large"
            >
              Ask
            </button>
          ) : null}
          <button
            type="submit"
            name="mode"
            value="search"
            className={`kf-button kf-button-large${canAsk ? '' : ' kf-button-primary'}`}
          >
            Search
          </button>
        </div>
      </form>
      <p className="kf-askbox-note">
        {canAsk
          ? 'Answers come only from records you can see, and list their sources.'
          : 'Written answers aren’t set up here yet; Search finds every record you can see.'}
      </p>
    </section>
  );
}
