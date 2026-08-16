import { describe, expect, it } from 'vitest';
import {
  validateDocumentProposalModelProvenance,
  validateDocumentProposalOperation,
} from '../../documents/src/proposal.js';

const SHA256 = 'a'.repeat(64);

describe('document proposal operation contract', () => {
  it('accepts and freezes an exact fragment source replacement', () => {
    const operation = validateDocumentProposalOperation({
      operation: 'replace_fragment_source',
      media_type: 'text/markdown',
      classification: 'internal',
      holder_id: 'holder-next',
      previous_holder_id: 'holder-current',
      holder: {
        kind: 'git',
        repository: 'openhuman/knowledge-fabric',
        commit_sha: 'b'.repeat(40),
        path: 'docs/purpose.md',
        submodule_commit_sha: null,
        content_digest: SHA256,
      },
    });

    expect(operation).toEqual({
      operation: 'replace_fragment_source',
      media_type: 'text/markdown',
      classification: 'internal',
      holder_id: 'holder-next',
      previous_holder_id: 'holder-current',
      holder: {
        kind: 'git',
        repository: 'openhuman/knowledge-fabric',
        commit_sha: 'b'.repeat(40),
        path: 'docs/purpose.md',
        submodule_commit_sha: null,
        content_digest: SHA256,
      },
    });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.holder)).toBe(true);
  });

  it('accepts exact, contiguous composition inputs for every applyable role', () => {
    const operation = validateDocumentProposalOperation({
      operation: 'replace_composition_inputs',
      classification: 'confidential',
      holder_id: 'holder-next',
      previous_holder_id: 'holder-current',
      holder: {
        kind: 'fabric_native',
        artifact_version_id: 'artifact-version-next',
        content_digest: SHA256,
      },
      inputs: [
        { ordinal: 1, role: 'fragment', fragment_revision_id: 'fragment-revision-1' },
        {
          ordinal: 2,
          role: 'composition',
          composition_revision_id: 'composition-revision-1',
        },
        {
          ordinal: 3,
          role: 'resource',
          resource_version_id: 'resource-version-1',
          content_digest: 'b'.repeat(64),
        },
        { ordinal: 4, role: 'binding', binding_id: 'binding-1' },
        {
          ordinal: 5,
          role: 'generated_view',
          compiled_view_id: 'view-1',
          content_digest: 'c'.repeat(64),
        },
      ],
    });

    expect(operation.operation).toBe('replace_composition_inputs');
    if (operation.operation !== 'replace_composition_inputs') throw new Error('unreachable');
    expect(operation.inputs.map((input) => input.role)).toEqual([
      'fragment',
      'composition',
      'resource',
      'binding',
      'generated_view',
    ]);
    expect(Object.isFrozen(operation.inputs)).toBe(true);
    expect(operation.inputs.every((input) => Object.isFrozen(input))).toBe(true);
  });

  it('preserves an exact external source-holder revision', () => {
    const operation = validateDocumentProposalOperation({
      operation: 'replace_fragment_source',
      media_type: 'text/liminal',
      classification: 'restricted',
      holder_id: 'holder-external-next',
      previous_holder_id: 'holder-external-current',
      holder: {
        kind: 'external',
        authority: 'regulated-dms',
        revision: 'revision-42',
        content_digest: SHA256,
      },
    });

    expect(operation.holder).toEqual({
      kind: 'external',
      authority: 'regulated-dms',
      revision: 'revision-42',
      content_digest: SHA256,
    });
  });

  it('fails closed on unsupported operations, extra fields, malformed digests, and input order', () => {
    expect(() => validateDocumentProposalOperation({ operation: 'approve_document' })).toThrow(
      /not supported/,
    );

    expect(() =>
      validateDocumentProposalOperation({
        operation: 'replace_fragment_source',
        media_type: 'text/markdown',
        classification: 'internal',
        holder_id: 'holder-next',
        previous_holder_id: 'holder-current',
        approval: true,
        holder: {
          kind: 'fabric_native',
          artifact_version_id: 'artifact-version-next',
          content_digest: SHA256,
        },
      }),
    ).toThrow(/unexpected fields: approval/);

    expect(() =>
      validateDocumentProposalOperation({
        operation: 'replace_fragment_source',
        media_type: 'text/markdown',
        classification: 'internal',
        holder_id: 'holder-next',
        previous_holder_id: 'holder-current',
        holder: {
          kind: 'external',
          authority: 'regulated-dms',
          revision: 'revision-42',
          content_digest: 'not-a-digest',
        },
      }),
    ).toThrow(/SHA-256/);

    expect(() =>
      validateDocumentProposalOperation({
        operation: 'replace_composition_inputs',
        classification: 'internal',
        holder_id: 'holder-next',
        previous_holder_id: 'holder-current',
        holder: {
          kind: 'fabric_native',
          artifact_version_id: 'artifact-version-next',
          content_digest: SHA256,
        },
        inputs: [{ ordinal: 2, role: 'binding', binding_id: 'binding-1' }],
      }),
    ).toThrow(/contiguous/);
  });
});

describe('document proposal model provenance contract', () => {
  const provenance = {
    request_id: 'request-01',
    basis_id: 'basis-01',
    classification: 'internal',
    provider: { provider_id: 'lamu', model_id: 'model-1', locality: 'local' },
    policy: {
      policy_id: 'local-first-v1',
      decision: { locality: 'local', classification_ceiling: 'restricted' },
    },
    context: {
      tokenizer: 'cl100k_base',
      token_budget: 2_048,
      instruction_digest: '64dfec5e310a44ba8a283d5f9f7ccf44441d9cbd0fb16a05e697f4c9b1927902',
      context_digest: '49853e71ba8f682cc846c2ad451d8777520def938f1821d0c93e0f8d6dc71ed1',
      included_items: [
        {
          subject_id: 'document-01',
          revision_id: 'revision-01',
          classification: 'internal',
          kind: 'document',
          token_count: 12,
          content_digest: '811c761b862105f47145a81453ae4133f895e07bcf649f6444732c4c1d23e6a2',
          provenance_digest: 'b'.repeat(64),
        },
      ],
      omitted_subject_ids: ['document-restricted'],
    },
  } as const;

  it('validates and freezes the exact provider, policy, and context claim', () => {
    const validated = validateDocumentProposalModelProvenance(provenance);

    expect(validated).toEqual(provenance);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.provider)).toBe(true);
    expect(Object.isFrozen(validated.policy.decision)).toBe(true);
    expect(Object.isFrozen(validated.context.included_items[0])).toBe(true);
  });

  it('fails closed on nested extras, invalid token counts, and a mismatched context digest', () => {
    expect(() =>
      validateDocumentProposalModelProvenance({
        ...provenance,
        provider: { ...provenance.provider, api_key: 'must-not-survive' },
      }),
    ).toThrow(/unexpected fields: api_key/);

    expect(() =>
      validateDocumentProposalModelProvenance({
        ...provenance,
        context: {
          ...provenance.context,
          included_items: [{ ...provenance.context.included_items[0], token_count: -1 }],
        },
      }),
    ).toThrow(/token_count/);

    expect(() =>
      validateDocumentProposalModelProvenance({
        ...provenance,
        context: { ...provenance.context, context_digest: 'c'.repeat(64) },
      }),
    ).toThrow(/context_digest does not match/);
  });
});
