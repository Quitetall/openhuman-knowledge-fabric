'use client';

import { formatState } from '@kf/ui';
import { useRef, useState } from 'react';
import { type DocumentDetail, type DocumentWorkspace } from '../../../lib/api';
import { DigestDisclosure } from '../../components/digest-disclosure';
import { SemanticDiffPanel } from './workbench-semantic-diff';
import { buildDocumentProposalInput } from './workbench-proposal';

const OPERATION_EXAMPLE = JSON.stringify(
  {
    operation: 'replace_fragment_source',
    media_type: 'text/markdown',
    classification: 'internal',
    holder_id: 'new-holder-uuid',
    previous_holder_id: 'current-holder-uuid',
    holder: {
      kind: 'fabric_native',
      artifact_version_id: 'immutable-artifact-version-uuid',
      content_digest: 'lowercase-sha256',
    },
  },
  null,
  2,
);

const COMPOSITION_OPERATION_EXAMPLE = JSON.stringify(
  {
    operation: 'replace_composition_inputs',
    classification: 'internal',
    holder_id: 'new-holder-uuid',
    previous_holder_id: 'current-holder-uuid',
    holder: {
      kind: 'fabric_native',
      artifact_version_id: 'immutable-artifact-version-uuid',
      content_digest: 'lowercase-sha256',
    },
    inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: 'fragment-revision-uuid' }],
  },
  null,
  2,
);

export function ProposalPanel({
  proposal,
  semanticNote,
  documentId,
  workspace,
  onProposalChange,
  onSemanticNoteChange,
}: {
  readonly proposal: string;
  readonly semanticNote: string;
  readonly documentId: string;
  readonly workspace: DocumentWorkspace;
  readonly onProposalChange: (value: string) => void;
  readonly onSemanticNoteChange: (value: string) => void;
}) {
  const [submission, setSubmission] = useState<
    | { readonly status: 'idle' | 'pending' }
    | { readonly status: 'accepted'; readonly proposalId: string }
    | { readonly status: 'refused'; readonly message: string }
  >({ status: 'idle' });
  const attemptId = useRef<string | undefined>(undefined);
  const ready = workspace.status === 'ready';
  const expectsComposition = ready && workspace.target.kind === 'document_composition';

  async function submitProposal(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (workspace.status !== 'ready') return;
    try {
      const id = attemptId.current ?? crypto.randomUUID();
      attemptId.current = id;
      setSubmission({ status: 'pending' });
      const response = await fetch(`/documents/${encodeURIComponent(documentId)}/proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          buildDocumentProposalInput({
            workspace,
            operationJson: proposal,
            reason: semanticNote,
            attemptId: id,
          }),
        ),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail =
          typeof body === 'object' &&
          body !== null &&
          'message' in body &&
          typeof body.message === 'string'
            ? body.message
            : 'The proposal action was refused.';
        throw new Error(detail);
      }
      setSubmission({ status: 'accepted', proposalId: id });
    } catch (error: unknown) {
      setSubmission({
        status: 'refused',
        message: error instanceof Error ? error.message : 'The proposal could not be submitted.',
      });
    }
  }

  return (
    <div style={{ maxWidth: '52rem' }}>
      <SemanticDiffPanel workspace={workspace} />
      <form onSubmit={submitProposal} style={{ marginTop: '2rem' }}>
        <h2>Typed proposal overlay</h2>
        {workspace.status === 'ready' ? (
          <p>
            Target <code>{workspace.target.objectId}</code>, revision{' '}
            <code>{workspace.target.baseRevisionId}</code>, row {workspace.target.rowVersion}; Basis{' '}
            <code>{workspace.basis.id}</code> with digest{' '}
            <DigestDisclosure digest={workspace.basis.digest} label="Compilation Basis digest" />.
          </p>
        ) : (
          <p id="proposal-unavailable" className="kf-status kf-status-warning">
            {workspace.status === 'ambiguous'
              ? 'More than one exact target/Basis mapping is visible.'
              : 'No exact finalized target/Basis mapping is visible.'}{' '}
            Proposal controls fail closed.
          </p>
        )}
        <fieldset
          disabled={!ready || submission.status === 'pending'}
          aria-describedby={ready ? 'proposal-boundary' : 'proposal-unavailable'}
          style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: '1rem' }}
        >
          <legend className="kf-sr-only">Exact source Holder proposal</legend>
          <label>
            Proposal reason (audit context)
            <textarea
              value={semanticNote}
              onChange={(event) => onSemanticNoteChange(event.target.value)}
              rows={3}
              className="kf-control"
            />
          </label>
          <label>
            Exact {expectsComposition ? 'replace_composition_inputs' : 'replace_fragment_source'}{' '}
            operation (JSON)
            <textarea
              value={proposal}
              onChange={(event) => onProposalChange(event.target.value)}
              rows={7}
              className="kf-control"
              placeholder={expectsComposition ? COMPOSITION_OPERATION_EXAMPLE : OPERATION_EXAMPLE}
              spellCheck={false}
            />
          </label>
          <button type="submit" className="kf-button">
            {submission.status === 'pending' ? 'Recording proposal…' : 'Record proposal'}
          </button>
        </fieldset>
        <p id="proposal-boundary" style={{ color: '#64748b' }}>
          Raw-text editing remains unavailable: this workbench cannot create an immutable artifact
          version or Holder. Supply an already-recorded exact Holder operation. Recording creates
          only a proposal; it does not apply, approve, publish, or allocate an enterprise
          identifier.
        </p>
        {submission.status === 'accepted' ? (
          <p className="kf-status kf-status-ok" role="status">
            Proposal {submission.proposalId} was recorded for separate review.
          </p>
        ) : null}
        {submission.status === 'refused' ? (
          <p className="kf-status kf-status-error" role="alert">
            {submission.message}
          </p>
        ) : null}
      </form>
    </div>
  );
}

export function PublicationPanel({
  document,
  workspace,
}: {
  readonly document: DocumentDetail;
  readonly workspace: DocumentWorkspace;
}) {
  return (
    <div style={{ maxWidth: '52rem' }}>
      <h2>Website publication preview</h2>
      <div style={{ border: '1px solid #cbd5e1', padding: '1rem', background: '#fff' }}>
        <strong>{document.title}</strong>
        <p>
          {document.documentNumber} · {document.revision} · {formatState(document.lifecycleState)}
        </p>
        <div style={{ margin: '1rem 0' }}>
          {document.parsedBlockCount} composed Parsed Blocks · digest{' '}
          {document.contentDigest === null ? (
            'unavailable'
          ) : (
            <DigestDisclosure digest={document.contentDigest} label="composed content digest" />
          )}
        </div>
      </div>
      <button type="button" disabled className="kf-button" style={{ marginTop: '1rem' }}>
        Publish — human authority and endpoint required
      </button>
      <p style={{ color: '#64748b' }}>
        Preview is non-authoritative. Only approved public revisions may become signed publication
        bundles. This page performs no signing or approval. The read-only public bundle projection
        can serve an existing signed bundle only after its receipt, public/effective state,
        signature, exact view digest, and file digests verify.
      </p>
      {workspace.status === 'ready' ? (
        <p>
          Current exact Basis exposes {workspace.projections.length} retained view
          {workspace.projections.length === 1 ? '' : 's'}; none is treated as published by this UI.
        </p>
      ) : null}
    </div>
  );
}
