import {
  parseDocumentProposalOperation,
  type DocumentProposalInput,
  type DocumentWorkspace,
} from '../../../lib/api';

export function buildDocumentProposalInput(input: {
  readonly workspace: DocumentWorkspace;
  readonly operationJson: string;
  readonly reason: string;
  readonly attemptId: string;
}): DocumentProposalInput {
  if (input.workspace.status !== 'ready') {
    throw new Error('an exact finalized target and Basis are required');
  }
  const operation = parseDocumentProposalOperation(JSON.parse(input.operationJson) as unknown);
  if (operation.previous_holder_id !== input.workspace.target.holderId) {
    throw new Error('previous_holder_id must equal the exact current Holder shown here');
  }
  const proposalKind =
    input.workspace.target.kind === 'document_composition' ? 'semantic_operations' : 'source_patch';
  if (proposalKind === 'source_patch' && operation.operation !== 'replace_fragment_source') {
    throw new Error('authored fragments require a replace_fragment_source operation');
  }
  if (
    proposalKind === 'semantic_operations' &&
    operation.operation !== 'replace_composition_inputs'
  ) {
    throw new Error('document compositions require a replace_composition_inputs operation');
  }
  const reason = input.reason.trim();
  return {
    proposalId: input.attemptId,
    basisId: input.workspace.basis.id,
    basisDigest: input.workspace.basis.digest,
    targetObjectId: input.workspace.target.objectId,
    baseRevisionId: input.workspace.target.baseRevisionId,
    targetRowVersion: input.workspace.target.rowVersion,
    proposalKind,
    operation,
    idempotencyKey: `document-proposal:${input.attemptId}`,
    ...(reason === '' ? {} : { reason }),
  };
}
