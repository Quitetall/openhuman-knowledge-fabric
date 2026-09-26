import { describe, expect, it } from 'vitest';

/**
 * The web server logs no request URL, fetch URL or server-function argument: query and record
 * text stay out of its log (next.config.mjs). Next's development logging is on unless it is turned
 * off, and it prints `GET /search?q=…` for every search.
 */
describe('the web server log', () => {
  it('is configured off, so no URL, fetch or server-function argument is printed', async () => {
    const config = ((await import('../../next.config.mjs')) as { default: { logging?: unknown } })
      .default;
    expect(config.logging).toBe(false);
  });
});
