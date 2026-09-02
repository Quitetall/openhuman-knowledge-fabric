/**
 * The web application's public API-client surface.
 *
 * Implementations are split by contract domain, while this compatibility barrel keeps every
 * existing import and export stable for pages, route handlers, components, and tests.
 */

export { ApiError, get } from './api/client';
export type { Caller, Decoder } from './api/client';
export { act, addDocument, getOperationalReadiness } from './api/operations';
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
export { parseObjectView } from './api/object-views';
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
export { getSearchResults, parseSearchResponse } from './api/search';
export type { SearchHit, SearchRequest, SearchResponse } from './api/search';
