/**
 * Document composition.
 *
 * Public interface stays small. Private atoms under internal/ own parsing, authority,
 * persistence, and action orchestration.
 */

export * from './compiler.js';
export * from './lamquant-compat.js';
export * from './liminal-adapter.js';
export * from './proposal.js';
export * from './adr.js';
export * from './workbench.js';
export * from './master-record.js';
export * from './master-record-boundary.js';
export * from './master-record-renderer.js';
export { verifyMasterRecordLinkToken, type MasterRecordLinkClaims } from './master-record-links.js';
export {
  enumeratePermissionSet,
  enumeratePermittedSet,
  enumerateRelevanceGraph,
  latestMasterRecord,
  masterRecordItems,
  masterRecordWithholdings,
} from './master-record-repository.js';

export { createDocumentActionAtoms } from './internal/action-atoms.js';
export { DOCUMENT_ACTION_IDS, type DocumentActionAtoms } from './internal/action-types.js';
export {
  artifactKindForDocumentClass,
  mediaTypeForDocumentFile,
  PandocDocumentParser,
} from './internal/pandoc-parser.js';
export { atomsFromPandoc, projectionFromPandoc } from './internal/pandoc-projection.js';
export {
  DocumentParseIntegrityError,
  PANDOC_PROJECTION_CONTRACT,
  validateParsedDocument,
  type DocumentAtom,
  type DocumentAtomKind,
  type DocumentParseLoss,
  type DocumentParser,
  type ParsedDocument,
} from './internal/parse-contract.js';
export {
  getDocument,
  listDocuments,
  type DocumentDetail,
  type DocumentSummary,
  type ParsedBlock,
} from './internal/readers.js';

export const PACKAGE = {
  name: '@kf/documents',
  role: 'Document parsing, composition, and controlled-document action atoms',
  owns: [],
} as const;

export {
  assembleBriefing,
  growBriefing,
  renderBriefing,
  type Briefing,
  type BriefingEntry,
  type BriefingSource,
} from './citation/assemble.js';
export {
  CitationSyntaxError,
  parseCitation,
  type Citation,
  type SectionSelector,
} from './citation/parse.js';
export { resolveCitation, type ResolvedExcerpt } from './citation/resolve.js';
export {
  compareSectionPaths,
  indexSections,
  isWithinSection,
  type SectionSpan,
} from './citation/sections.js';
