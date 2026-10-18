'use client';

import { useEffect, useRef } from 'react';
import { compileNow } from './actions';

/**
 * The first visit to an uncompiled master document compiles it: the same act, through the same
 * action and key, as the Refresh button — sent by the person's visit from their browser, never by
 * rendering the page (a prefetch or a crawler compiles nothing). Without script it is the plain
 * form, with its button.
 */
export function AutoCompile({ idempotencyKey }: { readonly idempotencyKey: string }) {
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, []);
  return (
    <form ref={form} action={compileNow} className="kf-autocompile" data-autocompile="">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <p role="status" aria-live="polite" className="kf-notice">
        <span className="kf-spinner" aria-hidden="true" /> Putting your master document together
        from everything you can see. This takes a moment the first time.
      </p>
      <noscript>
        <button type="submit" className="kf-button kf-button-primary">
          Put it together now
        </button>
      </noscript>
    </form>
  );
}
