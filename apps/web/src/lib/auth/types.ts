export const SESSION_COOKIE = '__Host-kf_session';
export const OIDC_TRANSACTION_COOKIE = '__Host-kf_oidc_transaction';
/**
 * The provider's ID token, kept only to send as `id_token_hint` at logout. A cookie of its own
 * rather than a field of the session: the session already carries the access token, and both
 * together would not fit one cookie's budget.
 */
export const ID_TOKEN_HINT_COOKIE = '__Host-kf_id_token_hint';
export const MAX_WEB_COOKIE_VALUE_BYTES = 3_800;
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

interface DevelopmentIdentityConfig {
  readonly profile: 'development';
}

export interface DogfoodIdentityConfig {
  readonly profile: 'dogfood';
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly sessionKey: Uint8Array;
}

export type WebIdentityConfig = DevelopmentIdentityConfig | DogfoodIdentityConfig;

export interface AuthorityContext {
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: Classification;
}

export interface WebSession {
  readonly version: 1;
  readonly accessToken: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly context?: AuthorityContext;
}

export interface OidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly returnTo: string;
  readonly expiresAt: number;
}
