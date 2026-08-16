/**
 * The tools an agent may use.
 *
 * Eight read. The ninth rehearses a real dispatcher action inside a rollback-only
 * transaction. There is still no general-purpose act() tool.
 */

export * from './ai.js';
export type {
  AgentScope,
  AvailableAction,
  EvidenceItem,
  ExternalCitation,
  HistoryEntry,
  ObjectSummary,
  TracedEdge,
  VerificationSummary,
} from './internal/types.js';
export {
  availableActions,
  findRecords,
  readHistory,
  readRecord,
} from './internal/basic-read-tools.js';
export {
  evidenceFor,
  externalCitations,
  traceRelations,
  verificationOf,
} from './internal/deep-read-tools.js';
export { rehearseAction, type Rehearsal } from './internal/rehearsal.js';

export const AGENT_TOOLS = [
  'find_records',
  'read_record',
  'read_history',
  'available_actions',
  'trace_relations',
  'verification_of',
  'external_citations',
  'evidence_for',
  'rehearse_action',
] as const;

export const PACKAGE = {
  name: '@kf/agent-tools',
  role: 'Typed agent tools: eight reads and one rehearsal, no writes',
  owns: [],
} as const;
