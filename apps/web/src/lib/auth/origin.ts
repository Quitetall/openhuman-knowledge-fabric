/** Anything carrying the address the application itself was reached on. */
type OriginSource = { readonly url: string };

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The origin this deployment is reached at, as configured — never as inferred from the request.
 *
 * `new URL(path, request.url)` looks right and is wrong behind a reverse proxy. Next.js builds
 * `request.url` from the address the application itself was reached on, which on the dogfood host
 * is the private interface nginx forwards to. So a person signing in from their own machine was
 * sent to `https://localhost:3000` — the loopback of the *server*, which for them is their own
 * machine, where nothing is listening. Ten routes had it, written the same way, because that line
 * is the obvious thing to write.
 *
 * In the dogfood profile the public origin is already configured and already load-bearing:
 * `KF_WEB_OIDC_REDIRECT_URI` is registered with the identity provider, which refuses a callback to
 * anything else. It is the one origin that cannot drift from reality without the provider saying
 * so, which makes it the right source rather than merely an available one.
 *
 * **Only those two variables are read, deliberately.** Resolving the full identity configuration
 * would make the origin depend on the session secret, and a deployment with a missing secret would
 * then fall back to the request address — the same defect, arriving by a quieter route. The origin
 * must not be contingent on anything but the origin.
 *
 * In development there is no proxy and no configured origin, so the request's own address is both
 * the only answer available and the correct one.
 */
export function publicOrigin(request: OriginSource, env: Environment = process.env): string {
  if (env['KF_DEPLOYMENT_PROFILE'] === 'dogfood') {
    const configured = env['KF_WEB_OIDC_REDIRECT_URI'];
    if (configured === undefined || configured === '') {
      // Unreachable through a working deployment: every OIDC route already requires this
      // variable. Raised rather than defaulted, because the wrong answer here sends a person
      // to a host that is not the one they asked for, and does it silently.
      throw new Error('KF_WEB_OIDC_REDIRECT_URI is required to build a redirect in dogfood');
    }
    try {
      return new URL(configured).origin;
    } catch {
      // A non-empty value that is not a URL — a bare path, a typo'd scheme. The opaque
      // TypeError that `new URL` raises names neither the variable nor the deployment.
      throw new Error(
        `KF_WEB_OIDC_REDIRECT_URI is not an absolute URL: ${JSON.stringify(configured)}`,
      );
    }
  }
  return new URL(request.url).origin;
}

/** A URL at the configured public origin. The replacement for `new URL(path, request.url)`. */
export function publicUrl(request: OriginSource, path: string): URL {
  return new URL(path, publicOrigin(request));
}
