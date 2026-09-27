/** Public web identity surface retained for existing route and component imports. */

export {
  CLASSIFICATIONS,
  CONTEXT_HINT_COOKIE,
  CONTEXT_HINT_LIFETIME_SECONDS,
  ID_TOKEN_HINT_COOKIE,
  MAX_WEB_COOKIE_VALUE_BYTES,
  OIDC_TRANSACTION_COOKIE,
  SESSION_COOKIE,
} from './auth/types';
export type {
  AuthorityContext,
  Classification,
  ContextHint,
  DogfoodIdentityConfig,
  OidcTransaction,
  WebIdentityConfig,
  WebSession,
} from './auth/types';
export { loadWebIdentityConfig } from './auth/config';
export { publicOrigin, publicUrl } from './auth/origin';
export { makePkceTransaction, sanitizeReturnTo, validateContextSelection } from './auth/context';
export {
  openContextHint,
  openIdTokenHint,
  openOidcTransaction,
  openWebSession,
  sealContextHint,
  sealIdTokenHint,
  sealOidcTransaction,
  sealWebSession,
} from './auth/cookies';
