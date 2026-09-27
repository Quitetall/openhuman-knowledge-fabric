/**
 * The web application's public API-client surface.
 *
 * Implementations are split by contract domain, while this compatibility barrel keeps every
 * existing import and export stable for pages, route handlers, components, and tests.
 */

export { ApiError, get } from './api/client';
export type { Caller, Decoder } from './api/client';
export { act, addDocument, getOperationalReadiness } from './api/operations';
export {
  captureInputFromForm,
  captureObservation,
  captureRequestBody,
  parseCaptureOutcome,
} from './api/capture';
export type { CaptureInput, CaptureOutcome } from './api/capture';
export type {
  ActionOutcome,
  AddDocumentInput,
  AddDocumentOutcome,
  OperationalCheckStatus,
  OperationalReadinessCheck,
  OperationalReadinessPartition,
  OperationalReadinessReport,
  OperationalReadinessScope,
} from './api/operations';
export { parseAvailableActionsView, parseHistoryView, parseProjectView } from './api/project-views';
export type { AvailableActionsView, HistoryView, ProjectView } from './api/project-views';
export { getSessionAssignments, parseSessionAssignments } from './api/session-assignments';
export type { SessionAssignment, SessionAssignments } from './api/session-assignments';
export { getSessionContexts, parseSessionContexts } from './api/session-contexts';
export type { SessionContextOrganization, SessionContexts } from './api/session-contexts';
export { parseObjectView, refreshObjectView } from './api/object-views';
export {
  ARTIFACT_TEXT_LIMIT_BYTES,
  artifactDerivation,
  artifactFile,
  getArtifactText,
  isPlainText,
} from './api/artifacts';
export type { ArtifactDerivation, ArtifactFile, ArtifactText } from './api/artifacts';
export type { ObjectView, ObjectViewMember } from './api/object-views';
export { parseDocumentDetail, parseDocumentsResponse } from './api/document-views';
export type {
  DocumentDetail,
  DocumentSourceProvenance,
  DocumentSummary,
  DocumentsResponse,
  ParsedBlock,
} from './api/document-views';
export { parseDocumentWorkspace } from './api/document-workspace';
export type {
  CompilationDiagnostic,
  CompilationLoss,
  DocumentWorkspace,
  SemanticChange,
  SemanticDiff,
  WorkspaceBasis,
  WorkspaceCompilation,
  WorkspaceCompositionGraph,
  WorkspaceCompositionInput,
  WorkspaceCompositionNode,
  WorkspaceHolder,
  WorkspaceNavigation,
  WorkspaceNavigationLink,
  WorkspaceProjection,
  WorkspaceTarget,
  WorkspaceTopicLink,
  WorkspaceAdrLink,
} from './api/document-workspace';
export { getDocumentDownload, postDocumentProposal } from './api/document-operations';
export {
  parseDocumentProposalOperation,
  parseDocumentProposalInput,
  parseReplaceCompositionInputsProposal,
  parseReplaceFragmentSourceProposal,
} from './api/document-proposal';
export type {
  DocumentProposalOperation,
  DocumentProposalInput,
  ProposalClassification,
  ProposalCompositionInput,
  ProposalSourceHolder,
  ReplaceCompositionInputsProposal,
  ReplaceFragmentSourceProposal,
} from './api/document-proposal';
export type { DocumentProposalOutcome } from './api/document-operations';
export type { MetricPanel, MetricView } from './api/metrics';
export {
  getOwnRecordedQueries,
  getSearchResults,
  parseSearchResponse,
  replayOrganizationDemand,
  replayRecordedQuery,
} from './api/search';
export type {
  DemandedRecord,
  DemandReplay,
  OwnRecordedQuery,
  RecordedQueryReplay,
  SearchHit,
  SearchRequest,
  SearchResponse,
  RankedSearchHit,
  SemanticSearchHit,
  WithholdingNote,
} from './api/search';
