/**
 * What a reviewed Keycloak realm must say before a host may trust it.
 *
 * The digest check proves the realm on disk is the one somebody reviewed. It says nothing about
 * whether the review should have passed: a realm with brute-force protection off, no password
 * policy and a password grant on admin-cli digests just as cleanly as a sound one. These are the
 * settings the committed realm (deploy/keycloak/knowledge-fabric-realm.json) was hardened to,
 * each refused here by name so a re-export that quietly reverts one cannot be commissioned.
 */

const DAY_SECONDS = 24 * 60 * 60;
/** Consecutive failures before a temporary lockout. Keycloak's default of 30 is a guessing budget. */
export const MAX_FAILURE_FACTOR = 10;
export const MIN_PASSWORD_LENGTH = 12;
/** An unused offline token dies after this long. */
export const MAX_OFFLINE_IDLE_SECONDS = 7 * DAY_SECONDS;
/** And every offline token dies after this long, used or not. */
export const MAX_OFFLINE_LIFESPAN_SECONDS = 30 * DAY_SECONDS;
/**
 * The longest an access token may live: the REPLAY BOUND on attestation (20260924001000).
 *
 * kf-attestor vouches that a person is present on the strength of a verified bearer token, and an
 * API process that is compromised sees every token passing through it, so it can have a fresh
 * attestation issued for any of them until that token expires. The window in which a compromised
 * API can act for somebody who has stopped using it is therefore the access-token lifespan, not
 * the attestation's one minute. Five minutes is what the shipped realm sets and what the threat
 * model and ADR 0033 state; a realm that raises it, or a client that overrides it, widens that
 * window and is refused.
 */
export const MAX_ACCESS_TOKEN_LIFESPAN_SECONDS = 300;
/** The client attribute Keycloak reads as a per-client override of accessTokenLifespan. */
const CLIENT_ACCESS_TOKEN_LIFESPAN = 'access.token.lifespan';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every reason this realm export is too weak to commission; empty when it is not. */
export function realmPolicyWeaknesses(text: string): string[] {
  let realm: unknown;
  try {
    realm = JSON.parse(text);
  } catch {
    return ['the reviewed policy is not a JSON realm export, so none of its settings can be read'];
  }
  if (!isRecord(realm)) return ['the reviewed policy is not a JSON object'];

  const weaknesses: string[] = [];

  if (realm['bruteForceProtected'] !== true) {
    weaknesses.push('bruteForceProtected is not true: passwords can be guessed without limit');
  } else {
    const factor = realm['failureFactor'];
    if (typeof factor !== 'number' || factor < 1 || factor > MAX_FAILURE_FACTOR) {
      weaknesses.push(
        `failureFactor is ${JSON.stringify(factor)}; lock out after at most ${MAX_FAILURE_FACTOR} failures`,
      );
    }
  }

  const policy = realm['passwordPolicy'];
  const length =
    typeof policy === 'string' ? Number(/(?:^|\s)length\((\d+)\)/.exec(policy)?.[1] ?? 0) : 0;
  if (length < MIN_PASSWORD_LENGTH) {
    weaknesses.push(
      `passwordPolicy does not require length(${MIN_PASSWORD_LENGTH}) or more ` +
        `(found ${JSON.stringify(policy ?? null)})`,
    );
  }
  if (typeof policy !== 'string' || !/(?:^|\s)notUsername(?:\(|\s|$)/.test(policy)) {
    weaknesses.push('passwordPolicy does not include notUsername');
  }

  // A second factor is required when every new account must enrol one before its first login.
  // The browser flow's conditional 2FA then demands it on every login after that.
  const actions = Array.isArray(realm['requiredActions']) ? realm['requiredActions'] : [];
  const enrolsSecondFactor = actions.some(
    (action) =>
      isRecord(action) &&
      (action['alias'] === 'CONFIGURE_TOTP' || action['alias'] === 'webauthn-register') &&
      action['enabled'] === true &&
      action['defaultAction'] === true,
  );
  if (!enrolsSecondFactor) {
    weaknesses.push(
      'no second factor is enrolled by default (CONFIGURE_TOTP or webauthn-register with ' +
        'defaultAction true): MFA is optional',
    );
  }

  const idle = realm['offlineSessionIdleTimeout'];
  if (typeof idle !== 'number' || idle <= 0 || idle > MAX_OFFLINE_IDLE_SECONDS) {
    weaknesses.push(
      `offlineSessionIdleTimeout is ${JSON.stringify(idle)}s; at most ${MAX_OFFLINE_IDLE_SECONDS}s`,
    );
  }
  const lifespan = realm['offlineSessionMaxLifespan'];
  if (
    realm['offlineSessionMaxLifespanEnabled'] !== true ||
    typeof lifespan !== 'number' ||
    lifespan <= 0 ||
    lifespan > MAX_OFFLINE_LIFESPAN_SECONDS
  ) {
    weaknesses.push(
      'offline sessions have no maximum lifespan of at most ' +
        `${MAX_OFFLINE_LIFESPAN_SECONDS}s: a token used once a month lives forever`,
    );
  }

  // Required, not defaulted to Keycloak's own 300: an export that does not state it is a realm
  // nobody reviewed the lifetime of.
  const access = realm['accessTokenLifespan'];
  if (
    typeof access !== 'number' ||
    !Number.isInteger(access) ||
    access <= 0 ||
    access > MAX_ACCESS_TOKEN_LIFESPAN_SECONDS
  ) {
    weaknesses.push(
      `accessTokenLifespan is ${JSON.stringify(access ?? null)}s; at most ` +
        `${MAX_ACCESS_TOKEN_LIFESPAN_SECONDS}s, because the attestation replay window is the ` +
        'access-token lifetime',
    );
  }

  if (realm['revokeRefreshToken'] !== true) {
    weaknesses.push('revokeRefreshToken is not true: a stolen refresh token stays usable');
  }

  const clients = Array.isArray(realm['clients']) ? realm['clients'] : [];
  for (const client of clients) {
    if (!isRecord(client)) continue;
    const id = JSON.stringify(client['clientId'] ?? null);
    if (client['directAccessGrantsEnabled'] === true) {
      weaknesses.push(
        `client ${id} allows direct access grants: a password posted straight to the token ` +
          'endpoint skips the login form, its brute-force screen and its second factor',
      );
    }
    if (client['implicitFlowEnabled'] === true) {
      weaknesses.push(`client ${id} allows the implicit flow`);
    }
    // A client-level override replaces the realm's lifespan for that client's tokens, so a sound
    // realm value says nothing about a client that sets its own. Keycloak stores it as a string;
    // an empty one means "use the realm's".
    const attributes = client['attributes'];
    const override = isRecord(attributes) ? attributes[CLIENT_ACCESS_TOKEN_LIFESPAN] : undefined;
    if (override !== undefined && override !== null && override !== '') {
      const seconds = typeof override === 'string' ? Number(override.trim()) : override;
      if (
        typeof seconds !== 'number' ||
        !Number.isInteger(seconds) ||
        seconds <= 0 ||
        seconds > MAX_ACCESS_TOKEN_LIFESPAN_SECONDS
      ) {
        weaknesses.push(
          `client ${id} overrides ${CLIENT_ACCESS_TOKEN_LIFESPAN} to ${JSON.stringify(override)}; ` +
            `at most ${MAX_ACCESS_TOKEN_LIFESPAN_SECONDS}s, because the attestation replay ` +
            'window is the access-token lifetime',
        );
      }
    }
  }

  return weaknesses;
}
