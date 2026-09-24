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
  OIDC_SIGNING_ALGORITHMS,
  TokenVerifier,
  agentOf,
  linkIdentity,
  resolveCaller,
  resolveIn,
  revokeIdentity,
  soleAssignment,
  type Caller,
  type CallerRequest,
  type IdentityConfig,
  type IdentityFailure,
  type LiveAssignment,
} from './identity.js';

export {
  ATTESTOR_MAX_BODY_BYTES,
  ATTESTOR_PATH,
  AttestorUnavailable,
  LocalAttestor,
  SocketAttestor,
  encodeAttestedCaller,
  encodeRefusal,
  parseAttestorRequest,
  type Attestor,
  type AttestorAvailability,
  type SocketAttestorOptions,
} from './attestor.js';

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

export {
  ACCESS_ACTION_IDS,
  ACCESS_EFFECTS,
  ACCESS_EXPLANATION_FORMAT,
  accessExplanationDigest,
  coveringGrants,
  enumerateAccessCoverage,
  explainAccess,
  grantAccessEffect,
  insertAccessGrant,
  revokeAccessEffect,
  type AccessCapability,
  type AccessCoverage,
  type AccessDenial,
  type AccessExplanation,
  type AccessGrantRef,
  type AccessGrantWrite,
  type AccessPrincipalKind,
  type AccessStep,
  type AccessStepOutcome,
} from './access-grants.js';
export {
  ORGANIZATION_LIFECYCLE_ACTION_IDS,
  activePeopleOf,
  createOrganizationLifecycleAtoms,
  endPersonAuthority,
  type OrganizationLifecycleAtoms,
} from './organization-lifecycle.js';
export {
  classificationsOf,
  reaches,
  readCoverage,
  readGranted,
  readGrantedSubset,
  type Classified,
  type ReadIdentity,
} from './read-grant.js';
