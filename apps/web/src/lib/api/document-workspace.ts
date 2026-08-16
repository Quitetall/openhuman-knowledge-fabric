import { isCompositionGraph, isWorkspaceNavigation } from './document-workspace-graph';
import type {
  CompilationDiagnostic,
  CompilationLoss,
  DocumentWorkspace,
  SemanticChange,
  SemanticDiff,
  WorkspaceBasis,
  WorkspaceCompilation,
  WorkspaceHolder,
  WorkspaceProjection,
  WorkspaceTarget,
} from './document-workspace-types';
import { hasStrings, nullableString, record } from './validation';

export type * from './document-workspace-types';

function holder(value: unknown): value is WorkspaceHolder {
  const item = record(value);
  if (item === undefined) return false;
  if (item['kind'] === 'fabric_native') {
    return (
      hasStrings(item, ['id', 'artifactVersionId', 'contentDigest']) &&
      nullableString(item['mediaType'])
    );
  }
  if (item['kind'] === 'git') {
    return (
      hasStrings(item, ['id', 'repository', 'commitSha', 'path', 'contentDigest']) &&
      nullableString(item['submoduleCommitSha'])
    );
  }
  return (
    item['kind'] === 'external' &&
    hasStrings(item, ['id', 'authority', 'revision', 'contentDigest'])
  );
}

function target(value: unknown): value is WorkspaceTarget {
  const item = record(value);
  return (
    item !== undefined &&
    (item['kind'] === 'authored_fragment' || item['kind'] === 'document_composition') &&
    ['ordinary', 'controlled', 'regulated'].includes(String(item['documentPolicy'])) &&
    hasStrings(item, [
      'objectId',
      'subjectId',
      'stableKey',
      'baseRevisionId',
      'rowVersion',
      'classification',
      'holderId',
      'contentDigest',
    ]) &&
    nullableString(item['mediaType']) &&
    holder(item['holder'])
  );
}

function basis(value: unknown): value is WorkspaceBasis {
  const item = record(value);
  return (
    item !== undefined &&
    hasStrings(item, ['id', 'digest', 'effectiveClassification', 'finalizedAt']) &&
    Array.isArray(item['targetProfiles'])
  );
}

function diagnostic(value: unknown): value is CompilationDiagnostic {
  const item = record(value);
  return (
    item !== undefined &&
    ['info', 'warning', 'error'].includes(String(item['severity'])) &&
    hasStrings(item, ['code', 'message'])
  );
}

function loss(value: unknown): value is CompilationLoss {
  const item = record(value);
  return (
    item !== undefined && hasStrings(item, ['code', 'message']) && nullableString(item['path'])
  );
}

function compilation(value: unknown): value is WorkspaceCompilation | null {
  if (value === null) return true;
  const item = record(value);
  return (
    item !== undefined &&
    hasStrings(item, ['runId', 'recordedAt']) &&
    ['succeeded', 'failed'].includes(String(item['status'])) &&
    typeof item['draftOnly'] === 'boolean' &&
    nullableString(item['semanticDigest']) &&
    Array.isArray(item['diagnostics']) &&
    item['diagnostics'].every(diagnostic) &&
    Array.isArray(item['conversionLoss']) &&
    item['conversionLoss'].every(loss)
  );
}

function projection(value: unknown): value is WorkspaceProjection {
  const item = record(value);
  return (
    item !== undefined &&
    hasStrings(item, [
      'id',
      'target',
      'mediaType',
      'artifactVersionId',
      'contentDigest',
      'effectiveClassification',
    ])
  );
}

function semanticChange(value: unknown): value is SemanticChange {
  const item = record(value);
  if (item === undefined || typeof item['path'] !== 'string') return false;
  if (item['kind'] === 'added') return Object.hasOwn(item, 'after');
  if (item['kind'] === 'removed') return Object.hasOwn(item, 'before');
  return (
    item['kind'] === 'changed' && Object.hasOwn(item, 'before') && Object.hasOwn(item, 'after')
  );
}

function semanticDiff(value: unknown): value is SemanticDiff {
  const item = record(value);
  if (item === undefined) return false;
  if (item['status'] === 'unavailable') return Object.keys(item).length === 1;
  return (
    item['status'] === 'available' &&
    hasStrings(item, ['fromRunId', 'toRunId']) &&
    Array.isArray(item['changes']) &&
    item['changes'].every(semanticChange) &&
    typeof item['truncated'] === 'boolean'
  );
}

export function parseDocumentWorkspace(value: unknown): DocumentWorkspace {
  const workspace = record(value);
  if (workspace === undefined) throw new Error('document workspace did not match contract');
  if (workspace['status'] === 'unavailable' || workspace['status'] === 'ambiguous') {
    if (Object.keys(workspace).length === 1) return workspace as DocumentWorkspace;
    throw new Error('fail-closed document workspace exposed concealed target facts');
  }
  if (
    workspace['status'] !== 'ready' ||
    !target(workspace['target']) ||
    !basis(workspace['basis']) ||
    !compilation(workspace['compilation']) ||
    !Array.isArray(workspace['projections']) ||
    !workspace['projections'].every(projection) ||
    !isCompositionGraph(workspace['composition']) ||
    !isWorkspaceNavigation(workspace['navigation']) ||
    !semanticDiff(workspace['semanticDiff'])
  ) {
    throw new Error('document workspace did not match contract');
  }
  return workspace as unknown as DocumentWorkspace;
}
