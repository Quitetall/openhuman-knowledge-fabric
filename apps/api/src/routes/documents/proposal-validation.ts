import {
  validateDocumentProposalOperation,
  type DocumentProposalOperation,
  type ReplaceCompositionInputsOperation,
} from '@kf/documents';
import type { WorkspaceTargetRow } from './workspace-repository.js';

export interface DocumentProposalBody {
  readonly proposalId?: unknown;
  readonly basisId?: unknown;
  readonly basisDigest?: unknown;
  readonly targetObjectId?: unknown;
  readonly baseRevisionId?: unknown;
  readonly targetRowVersion?: unknown;
  readonly proposalKind?: unknown;
  readonly operation?: unknown;
  readonly idempotencyKey?: unknown;
  readonly reason?: unknown;
}

export interface ParsedDocumentProposal {
  readonly proposalId: string;
  readonly basisId: string;
  readonly basisDigest: string;
  readonly targetObjectId: string;
  readonly baseRevisionId: string;
  readonly targetRowVersion: number;
  readonly proposalKind: 'source_patch' | 'semantic_operations';
  readonly operation: DocumentProposalOperation;
  readonly idempotencyKey: string;
  readonly reason: string | undefined;
}

export type ParsedDocumentProposalClaim = Omit<ParsedDocumentProposal, 'operation'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

function text(value: unknown, field: string, maximum = 500): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = text(value, field, 36);
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function digest(value: unknown, field: string): string {
  const parsed = text(value, field, 64);
  if (!DIGEST.test(parsed)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  return parsed;
}

export function parseDocumentProposalClaim(
  body: DocumentProposalBody,
): ParsedDocumentProposalClaim {
  if (body.proposalKind !== 'source_patch' && body.proposalKind !== 'semantic_operations') {
    throw new TypeError('proposalKind must be source_patch or semantic_operations');
  }
  const versionText = text(body.targetRowVersion, 'targetRowVersion', 20);
  const targetRowVersion = Number(versionText);
  if (!Number.isSafeInteger(targetRowVersion) || targetRowVersion < 1) {
    throw new TypeError('targetRowVersion must be a positive safe integer');
  }
  const reason = body.reason === undefined ? undefined : text(body.reason, 'reason', 2_000);
  const idempotencyKey = text(body.idempotencyKey, 'idempotencyKey', 128);
  if (idempotencyKey.length < 8)
    throw new TypeError('idempotencyKey must be at least 8 characters');
  return {
    proposalId: uuid(body.proposalId, 'proposalId'),
    basisId: uuid(body.basisId, 'basisId'),
    basisDigest: digest(body.basisDigest, 'basisDigest'),
    targetObjectId: uuid(body.targetObjectId, 'targetObjectId'),
    baseRevisionId: uuid(body.baseRevisionId, 'baseRevisionId'),
    targetRowVersion,
    proposalKind: body.proposalKind,
    idempotencyKey,
    reason,
  };
}

function validateSourceHolder(operation: DocumentProposalOperation): void {
  uuid(operation.holder_id, 'operation.holder_id');
  uuid(operation.previous_holder_id, 'operation.previous_holder_id');
  digest(operation.holder.content_digest, 'operation.holder.content_digest');
  if (operation.holder.kind === 'fabric_native') {
    uuid(operation.holder.artifact_version_id, 'operation.holder.artifact_version_id');
  }
}

function validateCompositionInputs(operation: ReplaceCompositionInputsOperation): void {
  for (const input of operation.inputs) {
    if (input.ordinal < 1 || !Number.isSafeInteger(input.ordinal)) {
      throw new TypeError('operation.inputs.ordinal must be a positive safe integer');
    }
    if (input.role === 'fragment')
      uuid(input.fragment_revision_id, 'operation.inputs.fragment_revision_id');
    if (input.role === 'composition') {
      uuid(input.composition_revision_id, 'operation.inputs.composition_revision_id');
    }
    if (input.role === 'resource') {
      uuid(input.resource_version_id, 'operation.inputs.resource_version_id');
      digest(input.content_digest, 'operation.inputs.content_digest');
    }
    if (input.role === 'binding') uuid(input.binding_id, 'operation.inputs.binding_id');
    if (input.role === 'generated_view') {
      uuid(input.compiled_view_id, 'operation.inputs.compiled_view_id');
      digest(input.content_digest, 'operation.inputs.content_digest');
    }
  }
}

export function parseDocumentProposal(body: DocumentProposalBody): ParsedDocumentProposal {
  const claim = parseDocumentProposalClaim(body);
  let operation;
  try {
    operation = validateDocumentProposalOperation(body.operation);
  } catch (error: unknown) {
    throw new TypeError(error instanceof Error ? error.message : 'proposal operation is invalid', {
      cause: error,
    });
  }
  if (claim.proposalKind === 'source_patch' && operation.operation !== 'replace_fragment_source') {
    throw new TypeError('source_patch proposals must replace the authored fragment source');
  }
  if (
    claim.proposalKind === 'semantic_operations' &&
    operation.operation !== 'replace_composition_inputs'
  ) {
    throw new TypeError('semantic_operations proposals must replace composition inputs');
  }
  validateSourceHolder(operation);
  if (operation.operation === 'replace_composition_inputs') validateCompositionInputs(operation);
  return { ...claim, operation };
}

export function proposalMatchesWorkspace(
  proposal: ParsedDocumentProposalClaim,
  target: WorkspaceTargetRow,
): boolean {
  return (
    proposal.basisId === target.basis_id &&
    proposal.basisDigest === target.basis_digest &&
    proposal.targetObjectId === target.target_object_id &&
    proposal.baseRevisionId === target.base_revision_id &&
    String(proposal.targetRowVersion) === target.target_row_version
  );
}
