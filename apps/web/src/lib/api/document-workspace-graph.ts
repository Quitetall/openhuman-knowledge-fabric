import type {
  WorkspaceAdrLink,
  WorkspaceCompositionGraph,
  WorkspaceCompositionInput,
  WorkspaceCompositionNode,
  WorkspaceNavigation,
  WorkspaceNavigationLink,
  WorkspaceTopicLink,
} from './document-workspace-types';
import { hasStrings, nullableString, record } from './validation';

function compositionNode(value: unknown): value is WorkspaceCompositionNode {
  const item = record(value);
  return (
    item !== undefined &&
    hasStrings(item, [
      'revisionId',
      'subjectId',
      'objectId',
      'title',
      'stableKey',
      'revisionDigest',
      'classification',
      'createdAt',
    ])
  );
}

function compositionInput(value: unknown): value is WorkspaceCompositionInput {
  const item = record(value);
  return (
    item !== undefined &&
    Number.isSafeInteger(item['ordinal']) &&
    Number(item['ordinal']) >= 1 &&
    ['fragment', 'composition', 'resource', 'binding', 'generated_view'].includes(
      String(item['role']),
    ) &&
    hasStrings(item, ['compositionRevisionId', 'targetId']) &&
    nullableString(item['targetTitle']) &&
    nullableString(item['contentDigest'])
  );
}

export function isCompositionGraph(value: unknown): value is WorkspaceCompositionGraph {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item['rootRevisionId'] === 'string' &&
    Array.isArray(item['nodes']) &&
    item['nodes'].every(compositionNode) &&
    Array.isArray(item['inputs']) &&
    item['inputs'].every(compositionInput)
  );
}

function navigationLink(value: unknown): value is WorkspaceNavigationLink {
  const item = record(value);
  return (
    item !== undefined &&
    (item['direction'] === 'outbound' || item['direction'] === 'inbound') &&
    hasStrings(item, [
      'id',
      'relationType',
      'peerObjectId',
      'peerObjectType',
      'peerTitle',
      'recordedAt',
    ])
  );
}

function adrLink(value: unknown): value is WorkspaceAdrLink {
  const item = record(value);
  return (
    item !== undefined &&
    hasStrings(item, ['decisionId', 'title', 'lifecycleState']) &&
    nullableString(item['latestProgressKind']) &&
    nullableString(item['topicKey'])
  );
}

function topicLink(value: unknown): value is WorkspaceTopicLink {
  const item = record(value);
  return (
    item !== undefined && hasStrings(item, ['decisionId', 'topicKey', 'title', 'lifecycleState'])
  );
}

export function isWorkspaceNavigation(value: unknown): value is WorkspaceNavigation {
  const item = record(value);
  return (
    item !== undefined &&
    Array.isArray(item['backlinks']) &&
    item['backlinks'].every(navigationLink) &&
    Array.isArray(item['traceability']) &&
    item['traceability'].every(navigationLink) &&
    Array.isArray(item['adr']) &&
    item['adr'].every(adrLink) &&
    Array.isArray(item['topics']) &&
    item['topics'].every(topicLink)
  );
}
