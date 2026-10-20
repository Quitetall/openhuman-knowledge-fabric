'use client';

import { useEffect, useId, useState, type ChangeEvent } from 'react';
import { flushSync } from 'react-dom';

/**
 * "Search by meaning": a switch inside a search form, on by default.
 *
 * It is a real checkbox, so it works without script. An unticked checkbox sends nothing, and
 * nothing has to mean on (the default), so a hidden `meaning=off` comes first and the checkbox
 * sends `meaning=on` after it when ticked; the page reads the last value (`searchByMeaning`).
 * Once script runs, the checkbox stops sending and the hidden field is sent only when off, so the
 * address reads `meaning=off` or nothing.
 *
 * With script, flipping it re-runs the search when the form already holds words, pressing the
 * button named by `submitter` so the form's mode (ask or search) is kept.
 *
 * Place it after the form's submit buttons: a submitter's value is sent in document order, and the
 * address then begins with the words and the mode, as it did before the switch existed.
 */
export function MeaningSwitch({
  on,
  submitter,
}: {
  readonly on: boolean;
  /** A selector for the button to press when re-running the search; the default button if absent. */
  readonly submitter?: string;
}) {
  const [checked, setChecked] = useState(on);
  const [hydrated, setHydrated] = useState(false);
  const hintId = useId();
  const inputId = useId();
  useEffect(() => setHydrated(true), []);

  function flip(event: ChangeEvent<HTMLInputElement>) {
    const next = event.currentTarget.checked;
    const form = event.currentTarget.form;
    flushSync(() => setChecked(next));
    const words = form?.elements.namedItem('q');
    if (form === null || !(words instanceof HTMLInputElement) || words.value.trim() === '') {
      return;
    }
    const button = submitter === undefined ? null : form.querySelector(submitter);
    form.requestSubmit(button instanceof HTMLButtonElement ? button : undefined);
  }

  return (
    <div className="kf-switch" data-meaning={checked ? 'on' : 'off'}>
      <input type="hidden" name="meaning" value="off" disabled={hydrated && checked} />
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        name={hydrated ? undefined : 'meaning'}
        value="on"
        checked={checked}
        onChange={flip}
        aria-describedby={hintId}
        className="kf-switch-input"
      />
      <label htmlFor={inputId} className="kf-switch-label">
        Search by meaning
      </label>
      <span id={hintId} className="kf-switch-hint">
        On: also finds records that say it in other words. Off: only exact words.
      </span>
    </div>
  );
}
