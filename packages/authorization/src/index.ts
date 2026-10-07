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
  IDENTIFICATION_SURFACES,
  IdentityRejected,
  OIDC_SIGNING_ALGORITHMS,
  TokenVerifier,
  agentOf,
  holdingsFrom,
  holdingsIn,
  linkIdentity,
  resolveCaller,
  resolveHoldings,
  resolveIn,
  revokeIdentity,
  soleAssignment,
  type Caller,
  type CallerRequest,
  type HeldAssignment,
  type HeldOrganization,
  type Holdings,
  type IdentityConfig,
  type IdentificationSurface,
  type IdentityFailure,
  type LiveAssignment,
} from './identity.js';

export {
  ATTESTOR_HOLDINGS_PATH,
  ATTESTOR_MAX_ANSWER_BYTES,
  ATTESTOR_MAX_BODY_BYTES,
  ATTESTOR_PATH,
  AttestorUnavailable,
  LocalAttestor,
  SocketAttestor,
  decodeHoldings,
  encodeAttestedCaller,
  encodeHoldings,
  encodeRefusal,
  parseAttestorRequest,
  parseHoldingsRequest,
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
export {
  AGENT_ACT_ACTION_IDS,
  AGENT_ACT_EFFECTS,
  AGENT_ACT_PRECONDITIONS,
  AGENT_ACT_RECEIPTS,
  PROPOSAL_RESOLUTIONS,
  VERIFICATION_POLICY_MODES,
  proposalRequest,
  proposedActOf,
  readProposal,
  type PendingProposal,
  type ProposalResolution,
  type ProposedAct,
  type VerificationPolicyMode,
} from './agent-acts.js';
export {
  AGENT_AT_HOME_ACTION_IDS,
  AGENT_AT_HOME_EFFECTS,
  AGENT_AT_HOME_PRECONDITIONS,
  AGENT_AT_HOME_RECEIPTS,
  DEFAULT_PROVIDER_CEILING,
  DIGEST_SETTINGS,
  PROVIDER_CEILINGS,
  PUSH_SETTINGS,
  type ProviderCeiling,
} from './agent-at-home.js';
