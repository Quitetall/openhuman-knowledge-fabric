/**
 * @kf/agent — the in-app agent (ADR 0040 decisions 7 and 8; SAS §24B; KF-WAR-0006).
 *
 *   answerTurn        one chat turn: retrieve, route by classification, answer, cite, count
 *   draftFromRequest  the real form for one act from M2's closed list, filled
 *   submitDraft       the person's one gesture: submitted unverified, or proposed into Needs you
 *   chooseBackend     the router; ProviderBackend the egress guard every provider call passes
 *   readGuide         the reader's Start Here guide while their own qualification is open: one
 *                     more source, labelled confidential at least (guide.ts)
 *
 * No I/O of its own beyond the Fabric API (as the person, through `FabricClient`) and the model
 * backends it is given. It keeps nothing.
 */

export {
  BackendUnavailable,
  EgressRefused,
  ProviderBackend,
  requestClassification,
  type ContextItem,
  type ConversationTurn,
  type ModelBackend,
  type ModelReply,
  type ModelRequest,
  type ProviderBackendOptions,
  type ProviderTransport,
} from './backends.js';
export {
  ABSOLUTE_LIMIT,
  CLASSIFICATIONS,
  DEFAULT_PROVIDER_CEILING,
  PROVIDER_CEILINGS,
  highestOf,
  isProviderCeiling,
  mayLeaveHost,
  rankOf,
  type Classification,
  type MayLeaveHost,
  type ProviderCeiling,
} from './classification.js';
export {
  AnthropicTransport,
  DEFAULT_PROVIDER_MODEL,
  PROVIDER_MODELS,
  providerBaseUrl,
  type AnthropicTransportOptions,
  type ProviderModel,
} from './anthropic.js';
export { LamuBackend, onHostUrl, type LamuOptions } from './lamu.js';
export { chooseBackend, type Backends, type RouteDecision } from './router.js';
export { checkCitations, renderMessages, renderSources, SYSTEM_PROMPT } from './prompt.js';
export { sealTurn, verifiedClassification, verifiedHistory, type CarriedTurn } from './seal.js';
export { record, refusalCode, refusalRule, type ApiAnswer, type FabricClient } from './fabric.js';
export {
  answerTurn,
  providerCeiling,
  DEFAULT_CONTEXT_LIMIT,
  MAX_QUESTION_CHARACTERS,
  type AgentDependencies,
  type ChatAnswer,
  type Citation,
  type TurnInput,
} from './turn.js';
export { asksToRecord, draftFromRequest, strippedRequest, type DraftOutcome } from './draft.js';
export { submitDraft, type SubmitInput, type SubmitOutcome } from './submit.js';
export {
  GUIDE_ACTS,
  GUIDE_MAY,
  GUIDE_MAY_NOT,
  guideItem,
  guideLabel,
  guidePermits,
  guideSystem,
  parseGuide,
  readGuide,
  type Guide,
  type GuideNext,
  type GuideRead,
} from './guide.js';
export { CredentialRefused, readOwnerOnlyFile } from './secret.js';
