import { record } from './validation';

export type ProposalClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export type ProposalSourceHolder =
  | {
      readonly kind: 'fabric_native';
      readonly artifact_version_id: string;
      readonly content_digest: string;
    }
  | {
      readonly kind: 'git';
      readonly repository: string;
      readonly commit_sha: string;
      readonly path: string;
      readonly submodule_commit_sha: string | null;
      readonly content_digest: string;
    }
  | {
      readonly kind: 'external';
      readonly authority: string;
      readonly revision: string;
      readonly content_digest: string;
    };

export interface ReplaceFragmentSourceProposal {
  readonly operation: 'replace_fragment_source';
  readonly media_type: string;
  readonly classification: ProposalClassification;
  readonly holder_id: string;
  readonly previous_holder_id: string;
  readonly holder: ProposalSourceHolder;
}

export type ProposalCompositionInput =
  | {
      readonly ordinal: number;
      readonly role: 'fragment';
      readonly fragment_revision_id: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'composition';
      readonly composition_revision_id: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'resource';
      readonly resource_version_id: string;
      readonly content_digest: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'binding';
      readonly binding_id: string;
    }
  | {
      readonly ordinal: number;
      readonly role: 'generated_view';
      readonly compiled_view_id: string;
      readonly content_digest: string;
    };

export interface ReplaceCompositionInputsProposal {
  readonly operation: 'replace_composition_inputs';
  readonly classification: ProposalClassification;
  readonly holder_id: string;
  readonly previous_holder_id: string;
  readonly holder: ProposalSourceHolder;
  readonly inputs: readonly ProposalCompositionInput[];
}

export type DocumentProposalOperation =
  | ReplaceFragmentSourceProposal
  | ReplaceCompositionInputsProposal;

export interface DocumentProposalInput {
  readonly proposalId: string;
  readonly basisId: string;
  readonly basisDigest: string;
  readonly targetObjectId: string;
  readonly baseRevisionId: string;
  readonly targetRowVersion: string;
  readonly proposalKind: 'source_patch' | 'semantic_operations';
  readonly operation: DocumentProposalOperation;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error('proposal contains missing or unknown fields');
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function digest(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!SHA256.test(parsed)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return parsed;
}

function classification(value: unknown): ProposalClassification {
  if (!CLASSIFICATIONS.includes(value as ProposalClassification)) {
    throw new Error('proposal classification is invalid');
  }
  return value as ProposalClassification;
}

function positiveOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('composition input ordinal must be a positive safe integer');
  }
  return value;
}

function sourceHolder(value: unknown): ProposalSourceHolder {
  const holder = record(value);
  if (holder === undefined) throw new Error('holder must be an object');
  if (holder['kind'] === 'fabric_native') {
    exactKeys(holder, ['kind', 'artifact_version_id', 'content_digest']);
    return {
      kind: holder['kind'],
      artifact_version_id: text(holder['artifact_version_id'], 'holder.artifact_version_id'),
      content_digest: digest(holder['content_digest'], 'holder.content_digest'),
    };
  }
  if (holder['kind'] === 'git') {
    exactKeys(holder, [
      'kind',
      'repository',
      'commit_sha',
      'path',
      'submodule_commit_sha',
      'content_digest',
    ]);
    const submodule = holder['submodule_commit_sha'];
    if (submodule !== null && typeof submodule !== 'string') {
      throw new Error('holder.submodule_commit_sha must be a string or null');
    }
    return {
      kind: holder['kind'],
      repository: text(holder['repository'], 'holder.repository'),
      commit_sha: text(holder['commit_sha'], 'holder.commit_sha'),
      path: text(holder['path'], 'holder.path'),
      submodule_commit_sha: submodule,
      content_digest: digest(holder['content_digest'], 'holder.content_digest'),
    };
  }
  if (holder['kind'] !== 'external') throw new Error('holder kind is not supported');
  exactKeys(holder, ['kind', 'authority', 'revision', 'content_digest']);
  return {
    kind: holder['kind'],
    authority: text(holder['authority'], 'holder.authority'),
    revision: text(holder['revision'], 'holder.revision'),
    content_digest: digest(holder['content_digest'], 'holder.content_digest'),
  };
}

function compositionInput(value: unknown): ProposalCompositionInput {
  const input = record(value);
  if (input === undefined) throw new Error('composition input must be an object');
  if (input['role'] === 'fragment') {
    exactKeys(input, ['ordinal', 'role', 'fragment_revision_id']);
    return {
      ordinal: positiveOrdinal(input['ordinal']),
      role: input['role'],
      fragment_revision_id: text(input['fragment_revision_id'], 'fragment_revision_id'),
    };
  }
  if (input['role'] === 'composition') {
    exactKeys(input, ['ordinal', 'role', 'composition_revision_id']);
    return {
      ordinal: positiveOrdinal(input['ordinal']),
      role: input['role'],
      composition_revision_id: text(input['composition_revision_id'], 'composition_revision_id'),
    };
  }
  if (input['role'] === 'resource') {
    exactKeys(input, ['ordinal', 'role', 'resource_version_id', 'content_digest']);
    return {
      ordinal: positiveOrdinal(input['ordinal']),
      role: input['role'],
      resource_version_id: text(input['resource_version_id'], 'resource_version_id'),
      content_digest: digest(input['content_digest'], 'content_digest'),
    };
  }
  if (input['role'] === 'binding') {
    exactKeys(input, ['ordinal', 'role', 'binding_id']);
    return {
      ordinal: positiveOrdinal(input['ordinal']),
      role: input['role'],
      binding_id: text(input['binding_id'], 'binding_id'),
    };
  }
  if (input['role'] !== 'generated_view') throw new Error('composition input role is invalid');
  exactKeys(input, ['ordinal', 'role', 'compiled_view_id', 'content_digest']);
  return {
    ordinal: positiveOrdinal(input['ordinal']),
    role: input['role'],
    compiled_view_id: text(input['compiled_view_id'], 'compiled_view_id'),
    content_digest: digest(input['content_digest'], 'content_digest'),
  };
}

export function parseReplaceFragmentSourceProposal(value: unknown): ReplaceFragmentSourceProposal {
  const operation = record(value);
  if (operation === undefined) throw new Error('proposal operation must be an object');
  exactKeys(operation, [
    'operation',
    'media_type',
    'classification',
    'holder_id',
    'previous_holder_id',
    'holder',
  ]);
  if (operation['operation'] !== 'replace_fragment_source') {
    throw new Error('proposal operation must be replace_fragment_source');
  }
  return {
    operation: operation['operation'],
    media_type: text(operation['media_type'], 'media_type'),
    classification: classification(operation['classification']),
    holder_id: text(operation['holder_id'], 'holder_id'),
    previous_holder_id: text(operation['previous_holder_id'], 'previous_holder_id'),
    holder: sourceHolder(operation['holder']),
  };
}

export function parseReplaceCompositionInputsProposal(
  value: unknown,
): ReplaceCompositionInputsProposal {
  const operation = record(value);
  if (operation === undefined) throw new Error('proposal operation must be an object');
  exactKeys(operation, [
    'operation',
    'classification',
    'holder_id',
    'previous_holder_id',
    'holder',
    'inputs',
  ]);
  if (operation['operation'] !== 'replace_composition_inputs') {
    throw new Error('proposal operation must be replace_composition_inputs');
  }
  if (!Array.isArray(operation['inputs']) || operation['inputs'].length === 0) {
    throw new Error('composition inputs must be a non-empty array');
  }
  return {
    operation: operation['operation'],
    classification: classification(operation['classification']),
    holder_id: text(operation['holder_id'], 'holder_id'),
    previous_holder_id: text(operation['previous_holder_id'], 'previous_holder_id'),
    holder: sourceHolder(operation['holder']),
    inputs: operation['inputs'].map(compositionInput),
  };
}

export function parseDocumentProposalOperation(value: unknown): DocumentProposalOperation {
  const operation = record(value);
  if (operation?.['operation'] === 'replace_composition_inputs') {
    return parseReplaceCompositionInputsProposal(value);
  }
  return parseReplaceFragmentSourceProposal(value);
}

export function parseDocumentProposalInput(value: unknown): DocumentProposalInput {
  const input = record(value);
  if (input === undefined) throw new Error('proposal request must be an object');
  exactKeys(
    input,
    [
      'proposalId',
      'basisId',
      'basisDigest',
      'targetObjectId',
      'baseRevisionId',
      'targetRowVersion',
      'proposalKind',
      'operation',
      'idempotencyKey',
    ],
    ['reason'],
  );
  if (input['proposalKind'] !== 'source_patch' && input['proposalKind'] !== 'semantic_operations') {
    throw new Error('proposalKind is invalid');
  }
  const operation = parseDocumentProposalOperation(input['operation']);
  if (input['proposalKind'] === 'source_patch' && operation.operation !== 'replace_fragment_source') {
    throw new Error('source_patch proposalKind requires replace_fragment_source');
  }
  if (
    input['proposalKind'] === 'semantic_operations' &&
    operation.operation !== 'replace_composition_inputs'
  ) {
    throw new Error('semantic_operations proposalKind requires replace_composition_inputs');
  }
  const reason = input['reason'] === undefined ? undefined : text(input['reason'], 'reason');
  return {
    proposalId: text(input['proposalId'], 'proposalId'),
    basisId: text(input['basisId'], 'basisId'),
    basisDigest: digest(input['basisDigest'], 'basisDigest'),
    targetObjectId: text(input['targetObjectId'], 'targetObjectId'),
    baseRevisionId: text(input['baseRevisionId'], 'baseRevisionId'),
    targetRowVersion: text(input['targetRowVersion'], 'targetRowVersion'),
    proposalKind: input['proposalKind'],
    operation,
    idempotencyKey: text(input['idempotencyKey'], 'idempotencyKey'),
    ...(reason === undefined ? {} : { reason }),
  };
}
