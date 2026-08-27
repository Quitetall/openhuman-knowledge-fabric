import type { ObjectStore } from '@kf/artifacts';
import { DOCUMENT_ACTION_IDS, type DocumentActionAtoms } from './action-types.js';
import { createCompilationAcceptActions } from './compilation-accept-actions.js';
import { createCompilationRequestActions } from './compilation-request-actions.js';
import { createCompositionAddActions } from './composition-add-actions.js';
import { createCompositionRevisionActions } from './composition-revision-actions.js';
import { createControlledDocumentActions } from './controlled-document-actions.js';
import { createEvidenceActions } from './evidence-actions.js';
import { createFragmentAddActions } from './fragment-add-actions.js';
import { createFragmentRevisionActions } from './fragment-revision-actions.js';
import { createHolderChangeActions } from './holder-change-actions.js';
import type { DocumentParser } from './parse-contract.js';
import { createProposalApplyActions } from './proposal-apply-actions.js';
import { createProposalRecordActions } from './proposal-record-actions.js';
import { createPublicationActions } from './publication-actions.js';
import { assertCompileMasterRecord, compileMasterRecordEffect } from './master-record-actions.js';

export function createDocumentActionAtoms(options: {
  readonly store: ObjectStore;
  readonly parser: DocumentParser;
}): DocumentActionAtoms {
  const evidence = createEvidenceActions(options);
  const controlled = createControlledDocumentActions();
  const fragmentAdd = createFragmentAddActions();
  const fragmentRevision = createFragmentRevisionActions();
  const compositionAdd = createCompositionAddActions();
  const compositionRevision = createCompositionRevisionActions();
  const holderChange = createHolderChangeActions();
  const compilationRequest = createCompilationRequestActions();
  const compilationAccept = createCompilationAcceptActions();
  const publication = createPublicationActions();
  const proposalRecord = createProposalRecordActions();
  const proposalApply = createProposalApplyActions();

  return {
    name: 'documents',
    ownedActions: DOCUMENT_ACTION_IDS,
    materializers: {
      attach_evidence: evidence.attachEvidence,
      add_controlled_document: controlled.addControlledDocument,
      add_authored_fragment: fragmentAdd.addAuthoredFragment,
      add_document_composition: compositionAdd.addDocumentComposition,
    },
    effects: {
      attach_evidence: evidence.recordEvidence,
      add_authored_fragment: fragmentAdd.materializeAuthoredFragment,
      revise_authored_fragment: fragmentRevision.reviseAuthoredFragment,
      retire_authored_fragment: fragmentRevision.retireAuthoredFragment,
      add_document_composition: compositionAdd.materializeDocumentComposition,
      revise_document_composition: compositionRevision.reviseDocumentComposition,
      change_document_source_holder: holderChange.changeDocumentSourceHolder,
      request_document_compilation: compilationRequest.requestDocumentCompilation,
      compile_master_record: compileMasterRecordEffect,
      accept_document_compilation: compilationAccept.acceptDocumentCompilation,
      publish_document_view: publication.publishDocumentView,
      record_document_proposal: proposalRecord.recordDocumentProposal,
      apply_document_proposal: proposalApply.applyDocumentProposal,
    },
    preconditions: {
      add_authored_fragment: fragmentAdd.assertAddFragment,
      revise_authored_fragment: fragmentRevision.assertReviseFragment,
      retire_authored_fragment: fragmentRevision.assertRetireFragment,
      add_document_composition: compositionAdd.assertAddComposition,
      revise_document_composition: compositionRevision.assertReviseComposition,
      change_document_source_holder: holderChange.assertChangeHolder,
      request_document_compilation: compilationRequest.assertRequestCompilation,
      compile_master_record: assertCompileMasterRecord,
      accept_document_compilation: compilationAccept.assertAcceptCompilation,
      publish_document_view: publication.assertPublishDocumentView,
      record_document_proposal: proposalRecord.assertRecordProposal,
      apply_document_proposal: proposalApply.assertApplyProposal,
    },
  };
}
