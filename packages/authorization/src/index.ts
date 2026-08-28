/**
 * Role resolution and action permission
 *
 * Paired with PostgreSQL row-level security, never a substitute for it. A denial must be
 * explainable without revealing data the actor may not see.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/authorization',
  role: 'Role resolution and action permission',
  owns: [],
};

export {
  IdentityRejected,
  TokenVerifier,
  linkIdentity,
  resolveCaller,
  resolveIn,
  revokeIdentity,
  type Caller,
  type CallerRequest,
  type IdentityConfig,
  type IdentityFailure,
} from './identity.js';

export {
  DEFAULT_STEP_UP,
  authenticationEvent,
  satisfiesStepUp,
  type AuthenticationEvent,
  type StepUpFailure,
  type StepUpPolicy,
  type StepUpResult,
} from './step-up.js';

export {
  AUTHORITY_ACTION_IDS,
  AUTHORITY_EFFECTS,
  grantPersonClearanceEffect,
  insertPersonClearance,
  type PersonClearanceGrant,
} from './clearance-actions.js';
