/** Public web identity surface retained for existing route and component imports. */

export {
  CLASSIFICATIONS,
  MAX_WEB_COOKIE_VALUE_BYTES,
  OIDC_TRANSACTION_COOKIE,
  SESSION_COOKIE,
} from './auth/types';
export type {
  AuthorityContext,
  Classification,
  DogfoodIdentityConfig,
  OidcTransaction,
  WebIdentityConfig,
  WebSession,
} from './auth/types';
export { loadWebIdentityConfig } from './auth/config';
export { makePkceTransaction, sanitizeReturnTo, validateContextSelection } from './auth/context';
export {
  openOidcTransaction,
  openWebSession,
  sealOidcTransaction,
  sealWebSession,
} from './auth/cookies';
