/**
 * The Content-Security-Policy every page is served with.
 *
 * Scripts run only with this response's nonce ('strict-dynamic' then trusts what those scripts
 * load), so an injected <script> or event-handler attribute does not execute. Next.js reads the
 * nonce back out of this header during server rendering and stamps it on its own scripts and
 * inline styles, which works because every route is dynamically rendered (the root layout is
 * `force-dynamic`); a statically prerendered page would carry no nonce and be blocked.
 *
 * Two deliberate allowances:
 *
 * - `style-src-attr 'unsafe-inline'`. The UI is styled with React `style` props, which reach
 *   the browser as style ATTRIBUTES on server-rendered HTML; no nonce can cover an attribute.
 *   Style attributes cannot run script, so this keeps the page rendering without reopening XSS.
 * - `form-action` names the identity provider. Sign-out is a same-origin form POST answered by
 *   a 303 to the provider's end-session endpoint, and browsers apply form-action to that
 *   redirect. Without the provider's origin the provider session would silently survive.
 *
 * `frame-ancestors 'none'` is here and also set by nginx, so framing stays refused even if a
 * response somehow leaves without this header.
 */
export function contentSecurityPolicy(
  nonce: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const development = env['NODE_ENV'] === 'development';
  // Only where the public origin is https. Behind nginx it is, and the upgrade closes any
  // http:// subresource a page might name. On a plain-http production build (the browser test,
  // a workstation `next start`) it would rewrite this app's own redirects to an https port
  // that does not exist.
  const publicHttps = (env['KF_WEB_OIDC_REDIRECT_URI'] ?? '').startsWith('https:');
  const formTargets = ["'self'"];
  const issuer = env['KF_WEB_OIDC_ISSUER'];
  if (issuer !== undefined && issuer !== '') {
    try {
      formTargets.push(new URL(issuer).origin);
    } catch {
      // Unparseable issuer: the OIDC routes refuse it themselves. The policy stays at 'self'.
    }
  }
  const directives = [
    "default-src 'self'",
    // React's development build uses eval for error overlays; production does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // The development overlay injects un-nonced <style> elements; production Next does not.
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Hot reload is a websocket back to the dev server.
    `connect-src 'self'${development ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${formTargets.join(' ')}`,
    "frame-ancestors 'none'",
    ...(publicHttps && !development ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}
