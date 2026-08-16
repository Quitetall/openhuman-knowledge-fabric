import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditChainDigest, digest, GENESIS_DIGEST } from '@kf/canonicalization';
import { withTransaction, type Tx } from '@kf/database';
import {
  createExport,
  exportIdentity,
  importExport,
  PRESERVATION_IMPORT_TARGETS,
  PRESERVATION_TABLE_EXCLUSIONS,
  signExportPackage,
  type ExportPackage,
} from './index.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
} from '../../../tests/database/harness.js';

const FIXED_AT = '2026-08-14T20:00:00.000Z';
const LATER_AT = '2026-08-14T20:01:00.000Z';
const EARLIER_AT = '2026-08-14T19:59:00.000Z';
const PRESERVATION_KEY_ID = 'extended-round-trip-key';
const PRESERVATION_KEY = generateKeyPairSync('ed25519');
const PRESERVATION_VERIFICATION = {
  trustedManifestKeys: new Map([[PRESERVATION_KEY_ID, PRESERVATION_KEY.publicKey]]),
};

function authenticateExport(pkg: ExportPackage): ExportPackage {
  return signExportPackage(pkg, {
    keyId: PRESERVATION_KEY_ID,
    privateKey: PRESERVATION_KEY.privateKey,
  });
}

let nextUuid = 1;
function uuid(): string {
  return `019b0000-0000-7000-8000-${String(nextUuid++).padStart(12, '0')}`;
}

function sha256(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function legacyActionDigest(actionId: string): string {
  return createHash('sha256').update(`kf-action-legacy-v1:${actionId}`, 'utf8').digest('hex');
}

function signature(byte: number): string {
  return Buffer.alloc(64, byte).toString('base64');
}

const FIXTURE_ED25519_SPKI = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.alloc(32, 4),
]);
const FIXTURE_ED25519_SPKI_BASE64 = FIXTURE_ED25519_SPKI.toString('base64');
const FIXTURE_ED25519_SPKI_SHA256 = createHash('sha256').update(FIXTURE_ED25519_SPKI).digest('hex');
const FIXTURE_REVOKED_PROMOTION_ED25519_SPKI = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.alloc(32, 5),
]);
const FIXTURE_REVOKED_PROMOTION_ED25519_SPKI_BASE64 =
  FIXTURE_REVOKED_PROMOTION_ED25519_SPKI.toString('base64');
const FIXTURE_REVOKED_PROMOTION_ED25519_SPKI_SHA256 = createHash('sha256')
  .update(FIXTURE_REVOKED_PROMOTION_ED25519_SPKI)
  .digest('hex');
const FIXTURE_PROMOTION_ED25519_SPKI = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.alloc(32, 6),
]);
const FIXTURE_PROMOTION_ED25519_SPKI_BASE64 = FIXTURE_PROMOTION_ED25519_SPKI.toString('base64');
const FIXTURE_PROMOTION_ED25519_SPKI_SHA256 = createHash('sha256')
  .update(FIXTURE_PROMOTION_ED25519_SPKI)
  .digest('hex');
const FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.alloc(32, 7),
]);
const FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI_BASE64 =
  FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI.toString('base64');
const FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI_SHA256 = createHash('sha256')
  .update(FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI)
  .digest('hex');
const FIXTURE_RUN_SEAL_ED25519_SPKI = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.alloc(32, 8),
]);
const FIXTURE_RUN_SEAL_ED25519_SPKI_BASE64 = FIXTURE_RUN_SEAL_ED25519_SPKI.toString('base64');
const FIXTURE_RUN_SEAL_ED25519_SPKI_SHA256 = createHash('sha256')
  .update(FIXTURE_RUN_SEAL_ED25519_SPKI)
  .digest('hex');

async function insert(tx: Tx, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  const parameters = columns.map((_, index) => `$${index + 1}`).join(', ');
  await tx.query(
    `insert into ${table} (${columns.join(', ')}) values (${parameters})`,
    Object.values(row),
  );
}

function rows(pkg: ExportPackage, section: string): Record<string, unknown>[] {
  const exported = pkg.files.find((candidate) => candidate.path === `${section}.json`);
  if (exported === undefined) throw new Error(`missing ${section}.json`);
  return JSON.parse(exported.content) as Record<string, unknown>[];
}

const AUTHORITATIVE_TARGETS = {
  'legacy-action-provenance': 'core.action_migration019_legacy',
  'audit-checkpoints': 'core.audit_checkpoint',
  'controlled-documents': 'quality.controlled_document',
  'document-subjects': 'content.document_subject',
  'document-source-holders': 'content.document_source_holder',
  'authored-fragments': 'content.authored_fragment',
  'document-compositions': 'content.document_composition',
  'authored-fragment-revisions': 'content.authored_fragment_revision',
  'composition-revisions': 'content.composition_revision',
  'composition-inputs': 'content.composition_input',
  'typed-bindings': 'content.typed_binding',
  'document-compiler-registrations': 'content.document_compiler_registration',
  'document-compiler-revocations': 'content.document_compiler_revocation',
  'compilation-bases': 'content.compilation_basis',
  'compilation-basis-fragments': 'content.compilation_basis_fragment',
  'compilation-basis-compositions': 'content.compilation_basis_composition',
  'compilation-basis-bindings': 'content.compilation_basis_binding',
  'compilation-runs': 'content.compilation_run',
  'compilation-run-preimages': 'content.compilation_run_preimage',
  'compiled-views': 'content.compiled_view',
  'document-publication-targets': 'content.document_publication_target',
  'document-publication-target-retirements': 'content.document_publication_target_retirement',
  'document-publications': 'content.document_publication',
  'proposal-overlays': 'content.proposal_overlay',
  'adr-decision-bodies': 'content.adr_decision_body',
  'ml-aggregate-references': 'ml.aggregate_reference',
  'ml-run-lineages': 'ml.run_lineage',
  'ml-run-lineage-inputs': 'ml.run_lineage_input',
  'ml-run-lineage-outputs': 'ml.run_lineage_output',
  'ml-run-lineage-parent-models': 'ml.run_lineage_parent_model',
  'ml-metric-definitions': 'ml.metric_definition',
  'ml-metric-write-authorizations': 'ml.metric_write_authorization',
  'ml-metric-events': 'ml.metric_event',
  'ml-metric-segments': 'ml.metric_segment',
  'ml-run-seal-signing-keys': 'ml.run_seal_signing_key',
  'ml-run-seals': 'ml.run_seal',
  'ml-run-seal-signing-key-revocations': 'ml.run_seal_signing_key_revocation',
  'ml-promotion-authority-decisions': 'ml.promotion_authority_decision',
  'ml-promotion-signing-keys': 'ml.promotion_signing_key',
  'ml-promotion-signing-key-revocations': 'ml.promotion_signing_key_revocation',
  'ml-promotion-receipts': 'ml.promotion_receipt',
  'ml-promotion-receipt-evidence': 'ml.promotion_receipt_evidence',
  'ml-promotion-revocations': 'ml.promotion_revocation',
  'recovery-objectives': 'ops.recovery_objective',
  'backup-runs': 'ops.backup_run',
  'backup-copies': 'ops.backup_copy',
  'restore-drills': 'ops.restore_drill',
  'physical-failure-domain-evidence': 'ops.physical_failure_domain_evidence',
  'encrypted-backup-evidence': 'ops.encrypted_backup_evidence',
  'secure-object-authority-signing-keys': 'secure_object.authority_signing_key',
  'secure-object-authority-signing-key-revocations':
    'secure_object.authority_signing_key_revocation',
  'secure-object-capability-requests': 'secure_object.capability_request',
  'secure-object-capability-issues': 'secure_object.capability_issue',
  'secure-object-capability-revocations': 'secure_object.capability_revocation',
  'secure-object-capability-consumptions': 'secure_object.capability_consumption',
  'secure-object-erasure-requests': 'secure_object.erasure_request',
  'secure-object-erasure-tombstones': 'secure_object.erasure_tombstone',
  'document-parses': 'content.document_parse',
  'document-atoms': 'content.document_atom',
} as const;

describe('extended preservation coverage', () => {
  it('round-trips document authority, ML receipts, operations evidence and secure-object receipts', async () => {
    const source = await startHarness();
    try {
      const fixtures = await seedFixtures(source.adminPool);
      const fragmentObjectId = await createObject(source.adminPool, fixtures, {
        type: 'authored_fragment',
        domain: 'qms',
        state: 'active',
        title: 'Preserved fragment subject',
        createdBy: fixtures.performerId,
      });
      const compositionObjectId = await createObject(source.adminPool, fixtures, {
        type: 'document_composition',
        domain: 'qms',
        state: 'active',
        title: 'Preserved composition subject',
        createdBy: fixtures.performerId,
      });
      const controlledDocumentObjectId = await createObject(source.adminPool, fixtures, {
        type: 'controlled_document',
        domain: 'qms',
        state: 'effective',
        title: 'Preserved effective publication revision',
        createdBy: fixtures.reviewerId,
      });
      const sourceArtifactId = await createObject(source.adminPool, fixtures, {
        type: 'artifact',
        domain: 'artifact',
        state: 'draft',
        title: 'Preserved authored bytes',
        createdBy: fixtures.performerId,
      });
      const compiledArtifactId = await createObject(source.adminPool, fixtures, {
        type: 'artifact',
        domain: 'artifact',
        state: 'draft',
        title: 'Rebuildable compiled bytes',
        createdBy: fixtures.performerId,
      });
      const technicalDecisionObjectId = await createObject(source.adminPool, fixtures, {
        type: 'ml_promotion_decision',
        domain: 'qms',
        state: 'recorded',
        title: 'Preserved technical promotion authority',
        createdBy: fixtures.reviewerId,
      });
      const qualityDecisionObjectId = await createObject(source.adminPool, fixtures, {
        type: 'ml_promotion_decision',
        domain: 'qms',
        state: 'recorded',
        title: 'Preserved quality promotion authority',
        createdBy: fixtures.performerId,
      });
      const adrDecisionObjectId = await createObject(source.adminPool, fixtures, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'accepted',
        title: 'ADR preservation decision',
        createdBy: fixtures.reviewerId,
      });

      const ids = {
        action: uuid(),
        acceptanceAction: uuid(),
        publicationAction: uuid(),
        secureAction: uuid(),
        auditEvent: uuid(),
        auditCheckpoint: uuid(),
        sourceVersion: uuid(),
        compiledVersion: uuid(),
        documentParse: uuid(),
        documentAtom: uuid(),
        fragmentSubject: fragmentObjectId,
        fragmentHolder: uuid(),
        fragmentRevision: uuid(),
        compositionSubject: compositionObjectId,
        compositionHolder: uuid(),
        compositionRevision: uuid(),
        binding: uuid(),
        compilerRegistration: uuid(),
        revokedCompilerRegistration: uuid(),
        basis: uuid(),
        run: uuid(),
        compiledView: uuid(),
        publicationTarget: uuid(),
        retiredPublicationTarget: uuid(),
        publicationReceipt: uuid(),
        proposal: uuid(),
        proposalHolder: uuid(),
        adrDecision: adrDecisionObjectId,
        adrDecisionBody: uuid(),
        mlRunRef: uuid(),
        mlCodeRef: uuid(),
        mlRecipeRef: uuid(),
        mlEnvironmentRef: uuid(),
        mlPolicyRef: uuid(),
        mlInputRef: uuid(),
        mlOutputRef: uuid(),
        mlParentRef: uuid(),
        mlDefinitionRef: uuid(),
        mlSegmentRef: uuid(),
        mlTechnicalDecisionRef: uuid(),
        mlQualityDecisionRef: uuid(),
        mlTechnicalDecisionObject: technicalDecisionObjectId,
        mlQualityDecisionObject: qualityDecisionObjectId,
        mlTechnicalDecisionAction: uuid(),
        mlQualityDecisionAction: uuid(),
        mlTechnicalDecisionApproval: uuid(),
        mlQualityDecisionApproval: uuid(),
        mlLineage: uuid(),
        mlDefinition: uuid(),
        mlMetricWriteAuthorization: uuid(),
        mlMetricAuthorizationAction: uuid(),
        mlEvent: uuid(),
        mlSegment: uuid(),
        mlRevokedRunSealSigningKey: uuid(),
        mlRunSealSigningKey: uuid(),
        mlSeal: uuid(),
        mlRevokedPromotionSigningKey: uuid(),
        mlPromotionSigningKey: uuid(),
        mlPromotion: uuid(),
        mlRevocation: uuid(),
        recoveryObjective: uuid(),
        backupRun: uuid(),
        backupCopy: uuid(),
        authoritySigningKey: uuid(),
        revokedAuthoritySigningKey: uuid(),
        capabilityRequest: uuid(),
        capabilityIssue: uuid(),
        consumedCapabilityRequest: uuid(),
        consumedCapabilityIssue: uuid(),
        erasureRequest: uuid(),
        erasureTombstone: uuid(),
      };

      const sourceDigest = sha256(1);
      const compiledDigest = sha256(2);

      await withTransaction(source.adminPool, async (tx) => {
        await bindContext(tx, fixtures);
        // This is a preservation fixture, not an alternate mutation API. All authority
        // boundaries have dedicated application-role suites; replica mode lets this owner
        // transaction construct a complete synthetic graph without fabricating dozens of
        // independently audited domain actions. Constraints and foreign keys still apply.
        await tx.query('set local session_replication_role = replica');

        await insert(tx, 'core.action', {
          id: ids.action,
          organization_id: fixtures.organizationId,
          request_digest: legacyActionDigest(ids.action),
          action_type: 'request_document_compilation',
          actor_id: fixtures.performerId,
          acting_role_id: fixtures.performerRoleId,
          target_ids: [compositionObjectId],
          parameters: JSON.stringify({
            basis_id: ids.basis,
            basis: { basisDigest: sha256(8) },
          }),
          preconditions: JSON.stringify({}),
          idempotency_key: 'extended-preservation-fixture',
          recorded_at: FIXED_AT,
          effective_at: FIXED_AT,
          request_id: 'extended-preservation-fixture',
          reason: 'Exercise every authoritative preservation section',
          result_status: 'applied',
          result: JSON.stringify({}),
        });
        await insert(tx, 'core.action_migration019_legacy', {
          action_id: ids.action,
          migration_version: 20260814001900,
        });
        await insert(tx, 'core.action', {
          id: ids.acceptanceAction,
          organization_id: fixtures.organizationId,
          request_digest: sha256(71),
          action_type: 'accept_document_compilation',
          actor_id: fixtures.reviewerId,
          acting_role_id: fixtures.reviewerRoleId,
          target_ids: [compositionObjectId],
          parameters: JSON.stringify({ run_id: ids.run, run_digest: sha256(16) }),
          preconditions: JSON.stringify({}),
          idempotency_key: 'extended-preservation-acceptance',
          recorded_at: FIXED_AT,
          effective_at: FIXED_AT,
          request_id: 'extended-preservation-acceptance',
          reason: 'Synthetic fixture acceptance for preservation coverage',
          result_status: 'applied',
          result: JSON.stringify({}),
        });
        await insert(tx, 'core.action', {
          id: ids.publicationAction,
          organization_id: fixtures.organizationId,
          request_digest: sha256(72),
          action_type: 'publish_document_view',
          actor_id: fixtures.reviewerId,
          acting_role_id: fixtures.reviewerRoleId,
          target_ids: [compositionObjectId],
          parameters: JSON.stringify({
            compiled_view_id: ids.compiledView,
            compiled_view_digest: compiledDigest,
            acceptance_action_id: ids.acceptanceAction,
            controlled_document_id: controlledDocumentObjectId,
            controlled_content_version_id: ids.compiledVersion,
            publication_target_id: ids.publicationTarget,
          }),
          preconditions: JSON.stringify({}),
          idempotency_key: 'extended-preservation-publication',
          recorded_at: LATER_AT,
          effective_at: LATER_AT,
          request_id: 'extended-preservation-publication',
          reason: 'Synthetic fixture publication for preservation coverage',
          result_status: 'applied',
          result: JSON.stringify({}),
        });
        await insert(tx, 'core.action', {
          id: ids.secureAction,
          organization_id: fixtures.organizationId,
          request_digest: sha256(73),
          action_type: 'attach_evidence',
          actor_id: fixtures.performerId,
          acting_role_id: fixtures.performerRoleId,
          target_ids: [fragmentObjectId],
          parameters: JSON.stringify({ fixture: 'secure-object-preservation' }),
          preconditions: JSON.stringify({}),
          idempotency_key: 'secure-object-preservation-fixture',
          recorded_at: FIXED_AT,
          effective_at: FIXED_AT,
          request_id: 'secure-object-preservation-fixture',
          reason: 'Exercise secure-object preservation receipts',
          result_status: 'applied',
          result: JSON.stringify({}),
        });
        await insert(tx, 'core.action', {
          id: ids.mlMetricAuthorizationAction,
          organization_id: fixtures.organizationId,
          request_digest: sha256(76),
          action_type: 'authorize_ml_metric_stream',
          actor_id: fixtures.reviewerId,
          acting_role_id: fixtures.reviewerRoleId,
          target_ids: [technicalDecisionObjectId],
          parameters: JSON.stringify({
            authorizedActorId: fixtures.performerId,
            authorizedRoleId: fixtures.performerRoleId,
            runLineageId: ids.mlLineage,
            metricDefinitionId: ids.mlDefinition,
            metricPolicyRefId: ids.mlPolicyRef,
          }),
          preconditions: JSON.stringify({}),
          idempotency_key: 'extended-preservation-metric-authorization',
          recorded_at: FIXED_AT,
          effective_at: FIXED_AT,
          request_id: 'extended-preservation-metric-authorization',
          reason: 'Synthetic metric-stream authority for preservation coverage',
          result_status: 'applied',
          result: JSON.stringify({}),
        });
        for (const decision of [
          {
            actionId: ids.mlTechnicalDecisionAction,
            approvalId: ids.mlTechnicalDecisionApproval,
            objectId: ids.mlTechnicalDecisionObject,
            actorId: fixtures.reviewerId,
            roleId: fixtures.reviewerRoleId,
            authorityKind: 'technical',
          },
          {
            actionId: ids.mlQualityDecisionAction,
            approvalId: ids.mlQualityDecisionApproval,
            objectId: ids.mlQualityDecisionObject,
            actorId: fixtures.performerId,
            roleId: fixtures.performerRoleId,
            authorityKind: 'quality',
          },
        ] as const) {
          await insert(tx, 'core.action', {
            id: decision.actionId,
            organization_id: fixtures.organizationId,
            request_digest: sha256(decision.authorityKind === 'technical' ? 74 : 75),
            action_type: 'authorize_ml_promotion',
            actor_id: decision.actorId,
            acting_role_id: decision.roleId,
            target_ids: [decision.objectId],
            parameters: JSON.stringify({
              aliasId: 'production',
              authorityKind: decision.authorityKind,
              candidateRefId: ids.mlOutputRef,
              runSealId: ids.mlSeal,
              policyRefId: ids.mlPolicyRef,
              riskTier: 'regulated',
            }),
            preconditions: JSON.stringify({}),
            idempotency_key: `extended-preservation-${decision.authorityKind}-decision`,
            recorded_at: FIXED_AT,
            effective_at: FIXED_AT,
            request_id: `extended-preservation-${decision.authorityKind}-decision`,
            reason: `Synthetic ${decision.authorityKind} promotion authority for preservation coverage`,
            result_status: 'applied',
            result: JSON.stringify({}),
          });
          await insert(tx, 'core.approval', {
            id: decision.approvalId,
            object_id: decision.objectId,
            action_id: decision.actionId,
            approver_id: decision.actorId,
            approver_role: decision.roleId,
            meaning: `Authorize exact ${decision.authorityKind} governed ML promotion decision`,
            recorded_at: FIXED_AT,
            effective_at: FIXED_AT,
          });
        }
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          fixtures.performerId,
          fixtures.performerRoleId,
          ids.action,
          'extended-preservation-fixture',
        ]);

        for (const [id, title, digest] of [
          [sourceArtifactId, 'authored', sourceDigest],
          [compiledArtifactId, 'compiled', compiledDigest],
        ] as const) {
          await insert(tx, 'content.artifact', {
            id,
            artifact_kind: 'specification',
            source_system: 'object_store',
          });
          await insert(tx, 'content.artifact_version', {
            id: title === 'authored' ? ids.sourceVersion : ids.compiledVersion,
            artifact_id: id,
            version_no: 1,
            revision_label: 'v1',
            sha256: digest,
            size_bytes: 128,
            media_type: 'text/markdown',
            storage_uri: `s3://preservation/${title}`,
            storage_version: 'object-version-1',
            created_at: FIXED_AT,
            created_by: fixtures.performerId,
            created_by_action: ids.action,
          });
        }

        const lossPreimage = '[]';
        const atomPreimage =
          '{"attributes":{},"kind":"paragraph","level":null,"ordinal":1,"text":"Preserved source atom"}';
        const projectionPreimage =
          `{"atoms":[${atomPreimage}],"conversionLoss":[],` +
          '"projectionContract":"kf.pandoc-atoms.v1"}';
        await insert(tx, 'content.document_parse', {
          id: ids.documentParse,
          artifact_version_id: ids.sourceVersion,
          parser: 'pandoc',
          parser_version: 'fixture-1',
          content_digest: createHash('sha256').update(projectionPreimage).digest('hex'),
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
          projection_contract: 'kf.pandoc-atoms.v1',
          conversion_loss: lossPreimage,
          source_digest: sourceDigest,
          loss_digest: createHash('sha256').update(lossPreimage).digest('hex'),
          loss_preimage: lossPreimage,
          projection_preimage: projectionPreimage,
        });
        await insert(tx, 'content.document_atom', {
          id: ids.documentAtom,
          parse_id: ids.documentParse,
          ordinal: 1,
          atom_kind: 'paragraph',
          heading_level: null,
          text_content: 'Preserved source atom',
          attributes: JSON.stringify({}),
          atom_digest: createHash('sha256').update(atomPreimage).digest('hex'),
          atom_preimage: atomPreimage,
        });

        await insert(tx, 'quality.controlled_document', {
          id: controlledDocumentObjectId,
          document_class: 'specification',
          document_number: 'TEST-PRESERVATION-PUBLICATION',
          revision: 'R1',
          owning_role: 'technical_authority',
          effective_from: FIXED_AT,
          content_version: ids.compiledVersion,
        });
        await insert(tx, 'content.document_publication_target', {
          id: ids.publicationTarget,
          organization_id: fixtures.organizationId,
          target_key: 'public-website-fixture',
          max_classification: 'internal',
          policy_digest: sha256(18),
          registered_at: FIXED_AT,
          registered_by: fixtures.reviewerId,
        });
        await insert(tx, 'content.document_publication_target', {
          id: ids.retiredPublicationTarget,
          organization_id: fixtures.organizationId,
          target_key: 'retired-website-fixture',
          max_classification: 'internal',
          policy_digest: sha256(19),
          registered_at: FIXED_AT,
          registered_by: fixtures.reviewerId,
        });
        await insert(tx, 'content.document_publication_target_retirement', {
          target_id: ids.retiredPublicationTarget,
          retired_at: LATER_AT,
          retired_by: fixtures.reviewerId,
          retirement_reason: 'Synthetic fixture retirement for preservation coverage',
        });

        await insert(tx, 'content.document_subject', {
          id: ids.fragmentSubject,
          object_id: fragmentObjectId,
          subject_kind: 'fragment',
          stable_key: 'preservation.fragment',
          document_policy: 'ordinary',
          current_holder_id: ids.fragmentHolder,
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
        });
        await insert(tx, 'content.document_source_holder', {
          id: ids.fragmentHolder,
          subject_id: ids.fragmentSubject,
          previous_holder_id: null,
          holder_kind: 'fabric_native',
          fabric_artifact_version_id: ids.sourceVersion,
          git_repository: null,
          git_commit_sha: null,
          git_path: null,
          git_submodule_commit_sha: null,
          external_authority: null,
          external_revision: null,
          content_digest: sourceDigest,
          conversion_loss: JSON.stringify([]),
          migration_reason: null,
          reversible_migration_plan: null,
          recorded_at: FIXED_AT,
          recorded_by: fixtures.performerId,
          recorded_by_action: ids.action,
        });
        await insert(tx, 'content.authored_fragment', {
          id: ids.fragmentSubject,
          subject_kind: 'fragment',
        });
        await insert(tx, 'content.authored_fragment_revision', {
          id: ids.fragmentRevision,
          fragment_id: ids.fragmentSubject,
          previous_revision_id: null,
          holder_id: ids.fragmentHolder,
          media_type: 'text/markdown',
          classification: 'internal',
          revision_state: 'active',
          content_digest: sourceDigest,
          revision_digest: sha256(3),
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
        });

        await insert(tx, 'content.document_subject', {
          id: ids.compositionSubject,
          object_id: compositionObjectId,
          subject_kind: 'composition',
          stable_key: 'preservation.composition',
          document_policy: 'controlled',
          current_holder_id: ids.compositionHolder,
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
        });
        await insert(tx, 'content.document_source_holder', {
          id: ids.compositionHolder,
          subject_id: ids.compositionSubject,
          previous_holder_id: null,
          holder_kind: 'external',
          fabric_artifact_version_id: null,
          git_repository: null,
          git_commit_sha: null,
          git_path: null,
          git_submodule_commit_sha: null,
          external_authority: 'preservation-fixture',
          external_revision: 'composition-v1',
          content_digest: sha256(4),
          conversion_loss: JSON.stringify([]),
          migration_reason: null,
          reversible_migration_plan: null,
          recorded_at: FIXED_AT,
          recorded_by: fixtures.performerId,
          recorded_by_action: ids.action,
        });
        await insert(tx, 'content.document_composition', {
          id: ids.compositionSubject,
          subject_kind: 'composition',
        });
        await insert(tx, 'content.composition_revision', {
          id: ids.compositionRevision,
          composition_id: ids.compositionSubject,
          previous_revision_id: null,
          revision_digest: sha256(5),
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
        });
        await insert(tx, 'content.typed_binding', {
          id: ids.binding,
          object_id: fragmentObjectId,
          source_kind: 'object_revision',
          object_revision: 1,
          snapshot_id: null,
          selector: 'lifecycle_state',
          expected_type: 'string',
          renderer: 'plain_text',
          resolved_value: JSON.stringify('draft'),
          value_digest: sha256(6),
          binding_digest: sha256(7),
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
        });
        await insert(tx, 'content.composition_input', {
          composition_revision_id: ids.compositionRevision,
          ordinal: 1,
          input_role: 'fragment',
          fragment_revision_id: ids.fragmentRevision,
          child_composition_revision_id: null,
          resource_version_id: null,
          binding_id: null,
          compiled_view_id: null,
          content_digest: null,
        });
        await insert(tx, 'content.composition_input', {
          composition_revision_id: ids.compositionRevision,
          ordinal: 2,
          input_role: 'binding',
          fragment_revision_id: null,
          child_composition_revision_id: null,
          resource_version_id: null,
          binding_id: ids.binding,
          compiled_view_id: null,
          content_digest: null,
        });
        await insert(tx, 'content.composition_input', {
          composition_revision_id: ids.compositionRevision,
          ordinal: 3,
          input_role: 'resource',
          fragment_revision_id: null,
          child_composition_revision_id: null,
          resource_version_id: ids.sourceVersion,
          binding_id: null,
          compiled_view_id: null,
          content_digest: sourceDigest,
        });
        await insert(tx, 'content.document_compiler_registration', {
          id: ids.compilerRegistration,
          compiler_name: 'liminal-preservation-test-compiler',
          compiler_version: '1.0.0',
          protocol: 'kf-document-v1',
          liminal_commit_sha: 'a'.repeat(40),
          cargo_lock_digest: sha256(20),
          executable_digest: sha256(12),
          runtime_closure_digest: sha256(24),
          qualification_state: 'qualified',
          qualification_receipt_digest: sha256(21),
          qualification_ratified: true,
          registered_at: FIXED_AT,
          registered_by: fixtures.reviewerId,
        });
        await insert(tx, 'content.document_compiler_registration', {
          id: ids.revokedCompilerRegistration,
          compiler_name: 'liminal-preservation-test-compiler',
          compiler_version: '0.9.0',
          protocol: 'kf-document-v1',
          liminal_commit_sha: 'b'.repeat(40),
          cargo_lock_digest: sha256(22),
          executable_digest: sha256(23),
          runtime_closure_digest: sha256(25),
          qualification_state: 'incomplete',
          qualification_receipt_digest: null,
          qualification_ratified: false,
          registered_at: FIXED_AT,
          registered_by: fixtures.reviewerId,
        });
        await insert(tx, 'content.document_compiler_revocation', {
          registration_id: ids.revokedCompilerRegistration,
          revoked_at: LATER_AT,
          revoked_by: fixtures.reviewerId,
          revocation_reason: 'Synthetic superseded compiler pin for preservation coverage',
        });
        await insert(tx, 'content.compilation_basis', {
          id: ids.basis,
          compiler_registration_id: ids.compilerRegistration,
          protocol: 'kf-document-v1',
          root_composition_revision_id: ids.compositionRevision,
          basis: JSON.stringify({ root: ids.compositionRevision }),
          basis_digest: sha256(8),
          ontology_digest: sha256(9),
          policy_digest: sha256(10),
          target_profiles: JSON.stringify([{ target: 'markdown', profile_digest: sha256(11) }]),
          compiler_kind: 'liminal',
          compiler_name: 'liminal-preservation-test-compiler',
          compiler_version: '1.0.0',
          liminal_commit_sha: 'a'.repeat(40),
          cargo_lock_digest: sha256(20),
          executable_digest: sha256(12),
          runtime_closure_digest: sha256(24),
          qualification_state: 'qualified',
          qualification_receipt_digest: sha256(21),
          qualification_ratified: true,
          created_at: FIXED_AT,
          created_by: fixtures.performerId,
          created_by_action: ids.action,
        });
        await insert(tx, 'content.compilation_basis_fragment', {
          basis_id: ids.basis,
          fragment_revision_id: ids.fragmentRevision,
        });
        await insert(tx, 'content.compilation_basis_composition', {
          basis_id: ids.basis,
          composition_revision_id: ids.compositionRevision,
        });
        await insert(tx, 'content.compilation_basis_binding', {
          basis_id: ids.basis,
          binding_id: ids.binding,
        });
        const finalizedClassification = await tx.one<{ classification: string }>(
          'select content.finalize_compilation_basis($1) as classification',
          [ids.basis],
        );
        expect(finalizedClassification.classification).toBe('internal');
        await insert(tx, 'content.compilation_run', {
          id: ids.run,
          basis_id: ids.basis,
          compiler_registration_id: ids.compilerRegistration,
          compiler_digest: sha256(13),
          dependency_digest: sha256(14),
          run_status: 'succeeded',
          draft_only: false,
          effective_classification: 'internal',
          semantic_digest: sha256(15),
          diagnostics: JSON.stringify([{ code: 'fixture_notice' }]),
          conversion_loss: JSON.stringify([]),
          hir_provenance: JSON.stringify([
            {
              nodeId: 'hir:fixture',
              sourceKind: 'fragment',
              sourceId: ids.fragmentRevision,
              sourcePath: null,
              sourceDigest,
            },
            {
              nodeId: 'hir:resource',
              sourceKind: 'resource',
              sourceId: ids.sourceVersion,
              sourcePath: null,
              sourceDigest,
            },
          ]),
          cir_provenance: JSON.stringify([
            {
              nodeId: 'cir:fixture',
              sourceKind: 'composition',
              sourceId: ids.compositionRevision,
              sourcePath: null,
              sourceDigest: sha256(5),
            },
            {
              nodeId: 'cir:fragment',
              sourceKind: 'fragment',
              sourceId: ids.fragmentRevision,
              sourcePath: null,
              sourceDigest,
            },
            {
              nodeId: 'cir:resource',
              sourceKind: 'resource',
              sourceId: ids.sourceVersion,
              sourcePath: null,
              sourceDigest,
            },
          ]),
          unresolved_references: JSON.stringify([]),
          omitted_subgraphs: JSON.stringify([]),
          projection_capabilities: JSON.stringify([{ target: 'markdown', supported: true }]),
          failure_code: null,
          failure_message: null,
          run_digest: sha256(16),
          recorded_at: FIXED_AT,
          requested_by_action: ids.action,
          recorded_by: fixtures.performerId,
        });
        await insert(tx, 'content.compiled_view', {
          id: ids.compiledView,
          compilation_run_id: ids.run,
          target: 'markdown',
          media_type: 'text/markdown',
          artifact_version_id: ids.compiledVersion,
          content_digest: compiledDigest,
          effective_classification: 'internal',
          recorded_at: FIXED_AT,
          recorded_by: fixtures.performerId,
        });
        await insert(tx, 'content.compilation_run_preimage', {
          run_id: ids.run,
          semantic_graph: JSON.stringify({ nodes: [{ id: 'fixture-node' }] }),
          semantic_preimage: '{"nodes":[{"id":"fixture-node"}]}',
          canonical_preimage: '{"format":"kf-document-compilation-run-v2"}',
          recorded_at: FIXED_AT,
          recorded_by: fixtures.performerId,
        });
        const proposalContextClaim = {
          tokenizer: 'fixture-tokenizer-v1',
          token_budget: 32,
          instruction_digest: sha256(50),
          included_items: [
            {
              subject_id: ids.fragmentSubject,
              revision_id: ids.fragmentRevision,
              classification: 'internal',
              kind: 'document',
              token_count: 8,
              content_digest: sourceDigest,
              provenance_digest: sha256(51),
            },
          ],
          omitted_subject_ids: [],
        };
        const proposalModelProvenance = {
          request_id: 'request-1',
          basis_id: ids.basis,
          classification: 'internal',
          provider: {
            provider_id: 'local',
            model_id: 'preservation-fixture-v1',
            locality: 'local',
          },
          policy: {
            policy_id: 'fixture-local-policy-v1',
            decision: { locality: 'local', classification_ceiling: 'internal' },
          },
          context: {
            ...proposalContextClaim,
            context_digest: digest(proposalContextClaim),
          },
        };
        await insert(tx, 'content.proposal_overlay', {
          id: ids.proposal,
          subject_id: ids.fragmentSubject,
          base_fragment_revision_id: ids.fragmentRevision,
          base_composition_revision_id: null,
          basis_id: ids.basis,
          proposal_kind: 'source_patch',
          proposed_by_kind: 'model',
          actor_id: null,
          model_provider: 'local',
          model_profile: 'preservation-fixture-v1',
          model_request_id: 'request-1',
          model_provenance: JSON.stringify(proposalModelProvenance),
          operations: JSON.stringify([
            {
              operation: 'replace_fragment_source',
              media_type: 'text/markdown',
              classification: 'internal',
              holder_id: ids.proposalHolder,
              previous_holder_id: ids.fragmentHolder,
              holder: {
                kind: 'fabric_native',
                artifact_version_id: ids.sourceVersion,
                content_digest: sourceDigest,
              },
            },
          ]),
          proposal_digest: sha256(17),
          created_at: FIXED_AT,
          created_by_action: ids.action,
        });
        await insert(tx, 'content.adr_decision_body', {
          id: ids.adrDecisionBody,
          decision_id: ids.adrDecision,
          document_revision_id: ids.fragmentRevision,
          body_state: 'accepted',
          body_digest: sourceDigest,
          recorded_at: FIXED_AT,
          recorded_by_action: ids.action,
        });

        const aggregateReferences = [
          [ids.mlRunRef, 'run'],
          [ids.mlCodeRef, 'code'],
          [ids.mlRecipeRef, 'recipe'],
          [ids.mlEnvironmentRef, 'environment'],
          [ids.mlPolicyRef, 'metric_policy'],
          [ids.mlInputRef, 'input'],
          [ids.mlOutputRef, 'candidate'],
          [ids.mlParentRef, 'parent_model'],
          [ids.mlDefinitionRef, 'metric_definition'],
          [ids.mlSegmentRef, 'segment'],
          [ids.mlTechnicalDecisionRef, 'evidence'],
          [ids.mlQualityDecisionRef, 'evidence'],
        ] as const;
        for (const [index, [id, kind]] of aggregateReferences.entries()) {
          await insert(tx, 'ml.aggregate_reference', {
            id,
            organization_id: fixtures.organizationId,
            aggregate_kind: kind,
            authority_id: `fixture.${kind}.${index + 1}`,
            revision_id: 'v1',
            sha256: sha256(20 + index),
            classification_id: 'internal',
            policy_id: 'preservation.v1',
          });
        }
        await insert(tx, 'ml.run_lineage', {
          id: ids.mlLineage,
          run_ref_id: ids.mlRunRef,
          code_ref_id: ids.mlCodeRef,
          recipe_ref_id: ids.mlRecipeRef,
          environment_ref_id: ids.mlEnvironmentRef,
          metric_policy_ref_id: ids.mlPolicyRef,
          lineage_sha256: sha256(31),
          recorded_at: FIXED_AT,
        });
        await insert(tx, 'ml.run_lineage_input', {
          run_lineage_id: ids.mlLineage,
          ordinal: 1,
          aggregate_ref_id: ids.mlInputRef,
        });
        await insert(tx, 'ml.run_lineage_output', {
          run_lineage_id: ids.mlLineage,
          ordinal: 1,
          aggregate_ref_id: ids.mlOutputRef,
        });
        await insert(tx, 'ml.run_lineage_parent_model', {
          run_lineage_id: ids.mlLineage,
          ordinal: 1,
          aggregate_ref_id: ids.mlParentRef,
        });
        await insert(tx, 'ml.metric_definition', {
          id: ids.mlDefinition,
          definition_ref_id: ids.mlDefinitionRef,
          metric_id: 'evaluation.accuracy',
          value_kind: 'number',
          unit_id: 'ratio',
          allowed_enum_ids: [],
        });
        await insert(tx, 'ml.metric_write_authorization', {
          id: ids.mlMetricWriteAuthorization,
          organization_id: fixtures.organizationId,
          actor_id: fixtures.performerId,
          acting_role_id: fixtures.performerRoleId,
          run_lineage_id: ids.mlLineage,
          metric_definition_id: ids.mlDefinition,
          metric_policy_ref_id: ids.mlPolicyRef,
          authorization_sha256: digest({
            actingRoleId: fixtures.performerRoleId,
            actionId: ids.mlMetricAuthorizationAction,
            actorId: fixtures.performerId,
            authorizedAt: FIXED_AT,
            metricDefinitionId: ids.mlDefinition,
            metricPolicyRefId: ids.mlPolicyRef,
            organizationId: fixtures.organizationId,
            runLineageId: ids.mlLineage,
            schemaVersion: 'kf.ml.metric-write-authorization.v2',
          }),
          authorized_at: FIXED_AT,
          schema_version: 2,
          action_id: ids.mlMetricAuthorizationAction,
        });
        await insert(tx, 'ml.metric_event', {
          id: ids.mlEvent,
          run_lineage_id: ids.mlLineage,
          metric_definition_id: ids.mlDefinition,
          metric_write_authorization_id: ids.mlMetricWriteAuthorization,
          idempotency_key: 'metric-event-1',
          sequence_no: 1,
          recorded_at: FIXED_AT,
          numeric_value: 0.875,
          enum_value: null,
          timestamp_value: null,
          event_sha256: sha256(32),
          status: 'provisional',
        });
        const metricEventManifest = [sha256(32)];
        const metricEventManifestDigest = digest(metricEventManifest);
        const metricSegmentDigest = digest({
          eventCount: 1,
          eventDigests: metricEventManifest,
          eventManifestDigest: metricEventManifestDigest,
          firstSequence: 1,
          lastSequence: 1,
          ordinal: 1,
          run: {
            authorityId: 'fixture.run.1',
            classificationId: 'internal',
            kind: 'run',
            organizationId: fixtures.organizationId,
            policyId: 'preservation.v1',
            revisionId: 'v1',
            sha256: sha256(20),
          },
          schemaVersion: 'kf.ml.metric-segment.v2',
          segment: {
            authorityId: 'fixture.segment.10',
            classificationId: 'internal',
            kind: 'segment',
            organizationId: fixtures.organizationId,
            policyId: 'preservation.v1',
            revisionId: 'v1',
            sha256: sha256(29),
          },
        });
        await insert(tx, 'ml.metric_segment', {
          id: ids.mlSegment,
          segment_ref_id: ids.mlSegmentRef,
          run_lineage_id: ids.mlLineage,
          ordinal: 1,
          first_sequence: 1,
          last_sequence: 1,
          event_count: 1,
          schema_version: 2,
          event_manifest: metricEventManifest,
          event_manifest_sha256: metricEventManifestDigest,
          metadata_sha256: metricSegmentDigest,
        });
        await insert(tx, 'ml.run_seal_signing_key', {
          id: ids.mlRevokedRunSealSigningKey,
          organization_id: fixtures.organizationId,
          workload_identity_ref: 'workload.blut.sealer',
          key_id: 'fixture-run-seal-key-old',
          algorithm: 'Ed25519',
          public_key_spki_der_base64: FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI_BASE64,
          public_key_sha256: FIXTURE_REVOKED_RUN_SEAL_ED25519_SPKI_SHA256,
          rotates_key_registry_id: null,
          valid_from: EARLIER_AT,
          valid_until: null,
          registered_at: EARLIER_AT,
        });
        await insert(tx, 'ml.run_seal_signing_key', {
          id: ids.mlRunSealSigningKey,
          organization_id: fixtures.organizationId,
          workload_identity_ref: 'workload.blut.sealer',
          key_id: 'fixture-run-seal-key',
          algorithm: 'Ed25519',
          public_key_spki_der_base64: FIXTURE_RUN_SEAL_ED25519_SPKI_BASE64,
          public_key_sha256: FIXTURE_RUN_SEAL_ED25519_SPKI_SHA256,
          rotates_key_registry_id: ids.mlRevokedRunSealSigningKey,
          valid_from: FIXED_AT,
          valid_until: null,
          registered_at: FIXED_AT,
        });
        await insert(tx, 'ml.run_seal', {
          id: ids.mlSeal,
          run_lineage_id: ids.mlLineage,
          lineage_sha256: sha256(31),
          segment_manifest: [metricSegmentDigest],
          segment_manifest_sha256: digest([metricSegmentDigest]),
          event_count: 1,
          sealed_at: FIXED_AT,
          signing_key_id: 'fixture-run-seal-key',
          signing_key_registry_id: ids.mlRunSealSigningKey,
          seal_sha256: sha256(35),
          signature: signature(1),
          recorded_at: FIXED_AT,
          schema_version: 2,
          event_manifest_sha256: metricEventManifestDigest,
        });
        for (const decision of [
          {
            objectId: ids.mlTechnicalDecisionObject,
            actionId: ids.mlTechnicalDecisionAction,
            approvalId: ids.mlTechnicalDecisionApproval,
            evidenceRefId: ids.mlTechnicalDecisionRef,
            approverId: fixtures.reviewerId,
            approverRoleId: fixtures.reviewerRoleId,
            authorityKind: 'technical',
            claimDigest: sha256(70),
          },
          {
            objectId: ids.mlQualityDecisionObject,
            actionId: ids.mlQualityDecisionAction,
            approvalId: ids.mlQualityDecisionApproval,
            evidenceRefId: ids.mlQualityDecisionRef,
            approverId: fixtures.performerId,
            approverRoleId: fixtures.performerRoleId,
            authorityKind: 'quality',
            claimDigest: sha256(71),
          },
        ] as const) {
          await insert(tx, 'ml.promotion_authority_decision', {
            object_id: decision.objectId,
            organization_id: fixtures.organizationId,
            action_id: decision.actionId,
            approval_id: decision.approvalId,
            evidence_ref_id: decision.evidenceRefId,
            approver_id: decision.approverId,
            approver_role_id: decision.approverRoleId,
            authority_kind: decision.authorityKind,
            alias_id: 'production',
            candidate_ref_id: ids.mlOutputRef,
            run_seal_id: ids.mlSeal,
            policy_ref_id: ids.mlPolicyRef,
            risk_tier: 'regulated',
            decision_claim_sha256: decision.claimDigest,
            effective_at: FIXED_AT,
            valid_until: null,
            recorded_at: FIXED_AT,
          });
        }
        await insert(tx, 'ml.promotion_signing_key', {
          id: ids.mlRevokedPromotionSigningKey,
          organization_id: fixtures.organizationId,
          key_id: 'fixture-ml-key-old',
          algorithm: 'Ed25519',
          public_key_spki_der_base64: FIXTURE_REVOKED_PROMOTION_ED25519_SPKI_BASE64,
          public_key_sha256: FIXTURE_REVOKED_PROMOTION_ED25519_SPKI_SHA256,
          rotates_key_registry_id: null,
          valid_from: EARLIER_AT,
          valid_until: null,
          registered_at: EARLIER_AT,
        });
        await insert(tx, 'ml.promotion_signing_key', {
          id: ids.mlPromotionSigningKey,
          organization_id: fixtures.organizationId,
          key_id: 'fixture-ml-key',
          algorithm: 'Ed25519',
          public_key_spki_der_base64: FIXTURE_PROMOTION_ED25519_SPKI_BASE64,
          public_key_sha256: FIXTURE_PROMOTION_ED25519_SPKI_SHA256,
          rotates_key_registry_id: ids.mlRevokedPromotionSigningKey,
          valid_from: FIXED_AT,
          valid_until: null,
          registered_at: FIXED_AT,
        });
        await insert(tx, 'ml.promotion_receipt', {
          id: ids.mlPromotion,
          organization_id: fixtures.organizationId,
          alias_id: 'production',
          candidate_ref_id: ids.mlOutputRef,
          run_seal_id: ids.mlSeal,
          policy_ref_id: ids.mlPolicyRef,
          evidence_manifest_sha256: sha256(36),
          risk_tier: 'regulated',
          technical_authority_decision_ref_id: ids.mlTechnicalDecisionRef,
          quality_authority_decision_ref_id: ids.mlQualityDecisionRef,
          promoted_at: FIXED_AT,
          signing_key_id: 'fixture-ml-key',
          receipt_sha256: sha256(37),
          signature: signature(2),
          recorded_at: FIXED_AT,
        });
        await insert(tx, 'ml.promotion_receipt_evidence', {
          promotion_receipt_id: ids.mlPromotion,
          ordinal: 1,
          evidence_ref_id: ids.mlTechnicalDecisionRef,
        });
        await insert(tx, 'ml.promotion_receipt_evidence', {
          promotion_receipt_id: ids.mlPromotion,
          ordinal: 2,
          evidence_ref_id: ids.mlQualityDecisionRef,
        });
        await insert(tx, 'ml.promotion_revocation', {
          id: ids.mlRevocation,
          organization_id: fixtures.organizationId,
          receipt_id: ids.mlPromotion,
          alias_id: 'production',
          reason_code: 'operator_withdrawal',
          revoked_at: LATER_AT,
          signing_key_id: 'fixture-ml-key',
          revocation_sha256: sha256(38),
          signature: signature(3),
          recorded_at: LATER_AT,
        });
        await insert(tx, 'ml.promotion_signing_key_revocation', {
          signing_key_registry_id: ids.mlRevokedPromotionSigningKey,
          reason_code: 'key_rotation',
          revoked_at: LATER_AT,
        });
        await insert(tx, 'ml.run_seal_signing_key_revocation', {
          signing_key_registry_id: ids.mlRevokedRunSealSigningKey,
          reason_code: 'key_rotation',
          revoked_at: LATER_AT,
        });

        await insert(tx, 'ops.recovery_objective', {
          id: ids.recoveryObjective,
          rpo_seconds: 900,
          restore_drill_days: 30,
          requires_pitr: true,
          declared_by: fixtures.reviewerId,
          declared_at: FIXED_AT,
          rationale: 'Preservation fixture requires bounded recovery evidence.',
          rto_seconds: 86_400,
        });
        await insert(tx, 'ops.backup_run', {
          id: ids.backupRun,
          started_at: FIXED_AT,
          finished_at: LATER_AT,
          kind: 'logical',
          location: 'fixture/backup-1',
          manifest_digest: sha256(40),
          byte_size: 4096,
          database_name: 'kf_fixture',
          recorded_at: LATER_AT,
        });
        await insert(tx, 'ops.backup_copy', {
          id: ids.backupCopy,
          backup_run_id: ids.backupRun,
          destination_label: 'fixture-offsite',
          offsite: true,
          copied_at: LATER_AT,
          manifest_digest: sha256(40),
        });
        await insert(tx, 'ops.restore_drill', {
          id: uuid(),
          backup_run_id: ids.backupRun,
          verified_at: LATER_AT,
          target_label: 'fixture-restore',
          outcome: 'verified',
          notes: 'Extended preservation fixture',
          recovery_seconds: 3600,
          database_verified: true,
          database_snapshot_sha256: sha256(41),
          checkpoint_verified: true,
          checkpoint_proof_sha256: sha256(42),
          object_store_verified: true,
          object_store_proof_ref: 'fixture://object-store/restore-proof',
          object_store_proof_sha256: sha256(43),
        });
        await insert(tx, 'ops.physical_failure_domain_evidence', {
          domain_ref: 'fixture-domain-1',
          evidence_ref: 'evidence://fixture/domain-1',
          approved_by: fixtures.reviewerId,
          approved_at: FIXED_AT,
          valid_until: null,
        });
        await insert(tx, 'ops.encrypted_backup_evidence', {
          backup_copy_id: ids.backupCopy,
          failure_domain_ref: 'fixture-domain-1',
          evidence_ref: 'evidence://fixture/encrypted-copy-1',
          encrypted: true,
          separate_from_primary: true,
          approved_by: fixtures.reviewerId,
          approved_at: LATER_AT,
          valid_until: null,
        });

        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          fixtures.performerId,
          fixtures.performerRoleId,
          ids.secureAction,
          'secure-object-preservation-fixture',
        ]);
        // Secure-object authority itself is covered through the unprivileged application
        // role in secure-object.test.ts; these rows exercise only preservation completeness.
        const capabilityRequestedAt = new Date();
        const capabilityExpiresAt = new Date(capabilityRequestedAt.getTime() + 300_000);
        const revokedContentDigest = sha256(40);
        const consumedContentDigest = sha256(41);
        const erasedContentDigest = sha256(42);
        const secureContext = {
          organization_id: fixtures.organizationId,
          classification_id: 'internal',
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
        };
        await insert(tx, 'secure_object.authority_signing_key', {
          id: ids.revokedAuthoritySigningKey,
          organization_id: fixtures.organizationId,
          external_authority_ref: 'secure-object-authority',
          key_id: 'fixture-erasure-key-old',
          algorithm: 'Ed25519',
          public_key_spki_der_base64: FIXTURE_ED25519_SPKI_BASE64,
          public_key_sha256: FIXTURE_ED25519_SPKI_SHA256,
          rotates_key_registry_id: null,
          valid_from: FIXED_AT,
          valid_until: null,
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          registered_at: FIXED_AT,
        });
        await insert(tx, 'secure_object.authority_signing_key', {
          id: ids.authoritySigningKey,
          organization_id: fixtures.organizationId,
          external_authority_ref: 'secure-object-authority',
          key_id: 'fixture-erasure-key',
          algorithm: 'Ed25519',
          public_key_spki_der_base64: FIXTURE_ED25519_SPKI_BASE64,
          public_key_sha256: FIXTURE_ED25519_SPKI_SHA256,
          rotates_key_registry_id: ids.revokedAuthoritySigningKey,
          valid_from: LATER_AT,
          valid_until: null,
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          registered_at: LATER_AT,
        });
        await insert(tx, 'secure_object.authority_signing_key_revocation', {
          signing_key_registry_id: ids.revokedAuthoritySigningKey,
          reason_code: 'key_rotation',
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          revoked_at: LATER_AT,
        });
        await insert(tx, 'secure_object.capability_request', {
          id: ids.capabilityRequest,
          ...secureContext,
          external_authority_ref: 'secure-object-authority',
          external_revision_ref: 'opaque-revision-1',
          external_content_sha256: revokedContentDigest,
          purpose: 'ml_training',
          workload_identity_ref: 'workload.revoked',
          policy_decision_ref: 'policy.revoked',
          idempotency_key: 'secure-request-revoked',
          ttl_seconds: 300,
          requested_at: capabilityRequestedAt,
          expires_at: capabilityExpiresAt,
        });
        await insert(tx, 'secure_object.capability_issue', {
          id: ids.capabilityIssue,
          request_id: ids.capabilityRequest,
          external_content_sha256: revokedContentDigest,
          purpose: 'ml_training',
          workload_identity_ref: 'workload.revoked',
          policy_decision_ref: 'policy.revoked',
          access_mode: 'read_exact_revision',
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          issued_at: capabilityRequestedAt,
        });
        await insert(tx, 'secure_object.capability_revocation', {
          capability_id: ids.capabilityIssue,
          external_content_sha256: revokedContentDigest,
          purpose: 'ml_training',
          workload_identity_ref: 'workload.revoked',
          policy_decision_ref: 'policy.revoked',
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          revoked_at: capabilityRequestedAt,
        });
        await insert(tx, 'secure_object.capability_request', {
          id: ids.consumedCapabilityRequest,
          ...secureContext,
          external_authority_ref: 'secure-object-authority',
          external_revision_ref: 'opaque-revision-2',
          external_content_sha256: consumedContentDigest,
          purpose: 'ml_evaluation',
          workload_identity_ref: 'workload.consumed',
          policy_decision_ref: 'policy.consumed',
          idempotency_key: 'secure-request-consumed',
          ttl_seconds: 300,
          requested_at: capabilityRequestedAt,
          expires_at: capabilityExpiresAt,
        });
        await insert(tx, 'secure_object.capability_issue', {
          id: ids.consumedCapabilityIssue,
          request_id: ids.consumedCapabilityRequest,
          external_content_sha256: consumedContentDigest,
          purpose: 'ml_evaluation',
          workload_identity_ref: 'workload.consumed',
          policy_decision_ref: 'policy.consumed',
          access_mode: 'read_exact_revision',
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          issued_at: capabilityRequestedAt,
        });
        await insert(tx, 'secure_object.capability_consumption', {
          capability_id: ids.consumedCapabilityIssue,
          external_content_sha256: consumedContentDigest,
          purpose: 'ml_evaluation',
          workload_identity_ref: 'workload.consumed',
          policy_decision_ref: 'policy.consumed',
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          consumed_at: capabilityRequestedAt,
        });
        await insert(tx, 'secure_object.erasure_request', {
          id: ids.erasureRequest,
          ...secureContext,
          external_authority_ref: 'secure-object-authority',
          external_revision_ref: 'opaque-erasure-revision-1',
          external_content_sha256: erasedContentDigest,
          purpose: 'authorized_erasure',
          workload_identity_ref: 'workload.erasure',
          policy_decision_ref: 'policy.erasure',
          requested_at: FIXED_AT,
        });
        await insert(tx, 'secure_object.erasure_tombstone', {
          id: ids.erasureTombstone,
          erasure_request_id: ids.erasureRequest,
          external_content_sha256: erasedContentDigest,
          purpose: 'authorized_erasure',
          workload_identity_ref: 'workload.erasure',
          policy_decision_ref: 'policy.erasure',
          tombstone_version: 'kf-secure-object-erasure-tombstone/v1',
          erased_at: LATER_AT,
          actor_id: fixtures.performerId,
          action_id: ids.secureAction,
          signing_key_registry_id: ids.authoritySigningKey,
          signing_key_id: 'fixture-erasure-key',
          signature: signature(4),
          recorded_at: LATER_AT,
        });
      });

      // Publication receipt trigger consumes immutable active action context, so publication
      // gets its own transaction just as dispatcher execution does. Synthetic fixture proves
      // preservation only; it never claims real-world acceptance or deployment.
      await withTransaction(source.adminPool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [
          fixtures.organizationId,
          'restricted',
        ]);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          fixtures.reviewerId,
          fixtures.reviewerRoleId,
          ids.publicationAction,
          'extended-preservation-publication',
        ]);
        await insert(tx, 'content.document_publication', {
          id: ids.publicationReceipt,
          action_id: ids.publicationAction,
          acceptance_action_id: ids.acceptanceAction,
          organization_id: fixtures.organizationId,
          subject_id: ids.compositionSubject,
          compiled_view_id: ids.compiledView,
          compiled_view_digest: compiledDigest,
          controlled_document_id: controlledDocumentObjectId,
          controlled_content_version_id: ids.compiledVersion,
          publication_target_id: ids.publicationTarget,
          publication_target_policy_digest: sha256(18),
          effective_classification: 'internal',
          published_at: LATER_AT,
          published_by: fixtures.reviewerId,
        });
      });

      // Audit receipts close actions only after every typed effect has materialized. This
      // mirrors dispatcher order and keeps open-action capability guards meaningful.
      await withTransaction(source.adminPool, async (tx) => {
        const actions = await tx.query<{
          id: string;
          action_type: string;
          actor_id: string;
          acting_role_id: string;
          target_ids: string[];
          recorded_at: string;
          effective_at: string;
          request_id: string | null;
          reason: string | null;
        }>(
          `select id::text, action_type, actor_id::text, acting_role_id::text, target_ids,
                  to_char(recorded_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at,
                  to_char(effective_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_at,
                  request_id, reason
             from core.action order by id`,
        );
        let previousDigest = GENESIS_DIGEST;
        for (const [index, action] of actions.entries()) {
          const afterDigest = sha256(61 + index);
          const auditDigest = auditChainDigest(previousDigest, {
            action_id: action.id,
            action_type: action.action_type,
            actor_id: action.actor_id,
            acting_role_id: action.acting_role_id,
            object_ids: action.target_ids,
            effective_at: action.effective_at,
            before_digest: null,
            after_digest: afterDigest,
          });
          await insert(tx, 'core.audit_event', {
            seq: index + 1,
            id: index === 0 ? ids.auditEvent : uuid(),
            action_id: action.id,
            actor_id: action.actor_id,
            acting_role_id: action.acting_role_id,
            action_type: action.action_type,
            object_id: action.target_ids.length === 1 ? action.target_ids[0] : null,
            recorded_at: action.recorded_at,
            effective_at: action.effective_at,
            request_id: action.request_id,
            reason: action.reason,
            before_digest: null,
            after_digest: afterDigest,
            prev_digest: previousDigest,
            digest: auditDigest,
          });
          previousDigest = auditDigest;
        }
        await insert(tx, 'core.audit_checkpoint', {
          id: ids.auditCheckpoint,
          format_version: 'kf.audit-checkpoint.v2',
          from_seq: 1,
          to_seq: 1,
          leaf_count: 1,
          merkle_root: sha256(60),
          signature: signature(5),
          signing_key_id: 'fixture-audit-checkpoint-key',
          storage_uri: 's3://preservation/audit-checkpoint-v2',
          recorded_at: FIXED_AT,
        });
      });

      const backupAccess = await withTransaction(source.adminPool, async (tx) => {
        await tx.query('set local role kf_backup');
        const visibleRows = await tx.one<{
          runSealSigningKeys: number;
          runSealSigningKeyRevocations: number;
          promotionAuthorityDecisions: number;
          promotionSigningKeys: number;
          promotionSigningKeyRevocations: number;
          promotionReceipts: number;
          promotionEvidence: number;
          promotionRevocations: number;
          physicalDomains: number;
          encryptedCopies: number;
        }>(
          `select
             (select count(*)::integer from ml.run_seal_signing_key) as "runSealSigningKeys",
             (select count(*)::integer from ml.run_seal_signing_key_revocation) as "runSealSigningKeyRevocations",
             (select count(*)::integer from ml.promotion_authority_decision) as "promotionAuthorityDecisions",
             (select count(*)::integer from ml.promotion_signing_key) as "promotionSigningKeys",
             (select count(*)::integer from ml.promotion_signing_key_revocation) as "promotionSigningKeyRevocations",
             (select count(*)::integer from ml.promotion_receipt) as "promotionReceipts",
             (select count(*)::integer from ml.promotion_receipt_evidence) as "promotionEvidence",
             (select count(*)::integer from ml.promotion_revocation) as "promotionRevocations",
             (select count(*)::integer from ops.physical_failure_domain_evidence) as "physicalDomains",
             (select count(*)::integer from ops.encrypted_backup_evidence) as "encryptedCopies"`,
        );
        const writePrivileges = await tx.one<{
          runSealSigningKeys: boolean;
          runSealSigningKeyRevocations: boolean;
          promotionAuthorityDecisions: boolean;
          promotionSigningKeys: boolean;
          promotionSigningKeyRevocations: boolean;
          promotionReceipts: boolean;
          promotionEvidence: boolean;
          promotionRevocations: boolean;
          physicalDomains: boolean;
          encryptedCopies: boolean;
        }>(
          `select
             has_table_privilege(current_user, 'ml.run_seal_signing_key',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "runSealSigningKeys",
             has_table_privilege(current_user, 'ml.run_seal_signing_key_revocation',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "runSealSigningKeyRevocations",
             has_table_privilege(current_user, 'ml.promotion_authority_decision',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "promotionAuthorityDecisions",
             has_table_privilege(current_user, 'ml.promotion_signing_key',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "promotionSigningKeys",
             has_table_privilege(current_user, 'ml.promotion_signing_key_revocation',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "promotionSigningKeyRevocations",
             has_table_privilege(current_user, 'ml.promotion_receipt',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "promotionReceipts",
             has_table_privilege(current_user, 'ml.promotion_receipt_evidence',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "promotionEvidence",
             has_table_privilege(current_user, 'ml.promotion_revocation',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "promotionRevocations",
             has_table_privilege(current_user, 'ops.physical_failure_domain_evidence',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "physicalDomains",
             has_table_privilege(current_user, 'ops.encrypted_backup_evidence',
               'INSERT, UPDATE, DELETE, TRUNCATE') as "encryptedCopies"`,
        );
        await tx.query('reset role');
        return { visibleRows, writePrivileges };
      });
      expect(backupAccess.visibleRows).toEqual({
        runSealSigningKeys: 2,
        runSealSigningKeyRevocations: 1,
        promotionAuthorityDecisions: 2,
        promotionSigningKeys: 2,
        promotionSigningKeyRevocations: 1,
        promotionReceipts: 1,
        promotionEvidence: 2,
        promotionRevocations: 1,
        physicalDomains: 1,
        encryptedCopies: 1,
      });
      expect(backupAccess.writePrivileges).toEqual({
        runSealSigningKeys: false,
        runSealSigningKeyRevocations: false,
        promotionAuthorityDecisions: false,
        promotionSigningKeys: false,
        promotionSigningKeyRevocations: false,
        promotionReceipts: false,
        promotionEvidence: false,
        promotionRevocations: false,
        physicalDomains: false,
        encryptedCopies: false,
      });

      const first = authenticateExport(
        await withTransaction(source.adminPool, async (tx) => createExport(tx)),
      );
      expect(first.manifest.counts).toMatchObject({
        'legacy-action-provenance': 1,
        'audit-events': 7,
        'audit-checkpoints': 1,
        'controlled-documents': 1,
        'document-subjects': 2,
        'document-source-holders': 2,
        'authored-fragments': 1,
        'document-compositions': 1,
        'authored-fragment-revisions': 1,
        'composition-revisions': 1,
        'composition-inputs': 3,
        'typed-bindings': 1,
        'document-compiler-registrations': 2,
        'document-compiler-revocations': 1,
        'compilation-bases': 1,
        'compilation-basis-fragments': 1,
        'compilation-basis-compositions': 1,
        'compilation-basis-bindings': 1,
        'compilation-runs': 1,
        'compilation-run-preimages': 1,
        'compiled-views': 1,
        'document-publication-targets': 2,
        'document-publication-target-retirements': 1,
        'document-publications': 1,
        'proposal-overlays': 1,
        'adr-decision-bodies': 1,
        'ml-aggregate-references': 12,
        'ml-run-lineages': 1,
        'ml-run-lineage-inputs': 1,
        'ml-run-lineage-outputs': 1,
        'ml-run-lineage-parent-models': 1,
        'ml-metric-definitions': 1,
        'ml-metric-write-authorizations': 1,
        'ml-metric-events': 1,
        'ml-metric-segments': 1,
        'ml-run-seal-signing-keys': 2,
        'ml-run-seals': 1,
        'ml-run-seal-signing-key-revocations': 1,
        'ml-promotion-authority-decisions': 2,
        'ml-promotion-signing-keys': 2,
        'ml-promotion-signing-key-revocations': 1,
        'ml-promotion-receipts': 1,
        'ml-promotion-receipt-evidence': 2,
        'ml-promotion-revocations': 1,
        'recovery-objectives': 1,
        'backup-runs': 1,
        'backup-copies': 1,
        'restore-drills': 1,
        'physical-failure-domain-evidence': 1,
        'encrypted-backup-evidence': 1,
        'secure-object-authority-signing-keys': 2,
        'secure-object-authority-signing-key-revocations': 1,
        'secure-object-capability-requests': 2,
        'secure-object-capability-issues': 2,
        'secure-object-capability-revocations': 1,
        'secure-object-capability-consumptions': 1,
        'secure-object-erasure-requests': 1,
        'secure-object-erasure-tombstones': 1,
        'document-parses': 1,
        'document-atoms': 1,
      });
      expect(first.files.some((entry) => entry.path.includes('classifier-lease'))).toBe(false);
      expect(first.files.some((entry) => entry.path.includes('compiler-runtime-lease'))).toBe(
        false,
      );
      expect(rows(first, 'audit-checkpoints')).toEqual([
        expect.objectContaining({
          id: ids.auditCheckpoint,
          format_version: 'kf.audit-checkpoint.v2',
        }),
      ]);
      expect(rows(first, 'legacy-action-provenance')).toEqual([
        { action_id: ids.action, migration_version: '20260814001900' },
      ]);
      expect(rows(first, 'adr-decision-bodies')).toEqual([
        expect.objectContaining({
          id: ids.adrDecisionBody,
          decision_id: ids.adrDecision,
          document_revision_id: ids.fragmentRevision,
          body_state: 'accepted',
          body_digest: sourceDigest,
        }),
      ]);

      // Closed preservation inventory: every base table is either exported or belongs to one
      // of the deliberately tiny reconstructed/ephemeral categories. A new table cannot become
      // authoritative merely by being forgotten here.
      await withTransaction(source.adminPool, async (tx) => {
        const liveTables = (
          await tx.query<{ qualified_name: string }>(
            `select table_schema || '.' || table_name as qualified_name
               from information_schema.tables
              where table_type = 'BASE TABLE'
                and table_schema = any($1::text[])
              order by table_schema, table_name`,
            [
              [
                'core',
                'org',
                'content',
                'work',
                'finance',
                'product',
                'engineering',
                'quality',
                'ops',
                'ml',
                'secure_object',
                'registry',
                'search',
              ],
            ],
          )
        ).map((row) => row.qualified_name);
        // `Set<string>`, not the literal union `PRESERVATION_IMPORT_TARGETS` infers. Both
        // assertions below compare the declared inventory against names read out of
        // `pg_class` at runtime, and a set narrowed to the union can only be asked about
        // names that are already in it — which is the opposite of the question.
        const exportedTables = new Set<string>(Object.values(PRESERVATION_IMPORT_TARGETS));
        const exclusions = Object.keys(PRESERVATION_TABLE_EXCLUSIONS);
        const isExcluded = (qualifiedName: string): boolean =>
          exclusions.some((excluded) =>
            excluded.endsWith('.*')
              ? qualifiedName.startsWith(excluded.slice(0, -1))
              : qualifiedName === excluded,
          );

        expect(
          liveTables.filter((table) => !exportedTables.has(table) && !isExcluded(table)),
          'application tables missing from preservation inventory',
        ).toEqual([]);
        expect(
          [...exportedTables].filter((table) => !liveTables.includes(table)),
          'preservation inventory names a table that does not exist',
        ).toEqual([]);
        for (const section of Object.keys(PRESERVATION_IMPORT_TARGETS)) {
          expect(first.manifest.counts, `manifest has no count for ${section}`).toHaveProperty(
            section,
          );
          expect(
            first.files.some((entry) => entry.path === `${section}.json`),
            `export has no ${section}.json`,
          ).toBe(true);
        }
      });

      // A row-count round trip would stay green if the exporter quietly omitted one column
      // on both sides. Compare the public section shape with the migrated source-of-truth
      // catalogue so every fact in each authoritative table is carried.
      await withTransaction(source.adminPool, async (tx) => {
        for (const [section, qualifiedTable] of Object.entries(AUTHORITATIVE_TARGETS)) {
          const [schema, table] = qualifiedTable.split('.');
          const columns = await tx.query<{ column_name: string }>(
            `select column_name from information_schema.columns
              where table_schema = $1 and table_name = $2 and is_generated = 'NEVER'
              order by column_name`,
            [schema, table],
          );
          expect(
            Object.keys(rows(first, section)[0]!).sort(),
            `${section} dropped a column`,
          ).toEqual(columns.map((column) => column.column_name));
        }
      });

      // Compiled bytes are explicitly rebuildable; the durable run/view receipt and its
      // artifact-version digest are not. The preservation package carries the latter only.
      expect(rows(first, 'compilation-bases')).toEqual([
        expect.objectContaining({
          id: ids.basis,
          effective_classification: 'internal',
          finalized_at: {
            $kf_type: 'postgres.timestamptz',
            text: expect.any(String),
          },
        }),
      ]);
      expect(rows(first, 'compilation-runs')).toEqual([
        expect.objectContaining({
          id: ids.run,
          requested_by_action: ids.action,
          effective_classification: 'internal',
        }),
      ]);
      expect(rows(first, 'compilation-run-preimages')).toEqual([
        expect.objectContaining({
          run_id: ids.run,
          semantic_preimage: '{"nodes":[{"id":"fixture-node"}]}',
          canonical_preimage: '{"format":"kf-document-compilation-run-v2"}',
        }),
      ]);
      expect(rows(first, 'document-parses')).toEqual([
        expect.objectContaining({
          id: ids.documentParse,
          source_digest: sourceDigest,
          loss_preimage: '[]',
          projection_preimage: expect.stringContaining('kf.pandoc-atoms.v1'),
        }),
      ]);
      expect(rows(first, 'document-atoms')).toEqual([
        expect.objectContaining({
          id: ids.documentAtom,
          parse_id: ids.documentParse,
          atom_preimage: expect.stringContaining('Preserved source atom'),
        }),
      ]);
      expect(rows(first, 'compiled-views')).toEqual([
        expect.objectContaining({
          id: ids.compiledView,
          compilation_run_id: ids.run,
          artifact_version_id: ids.compiledVersion,
          content_digest: compiledDigest,
          effective_classification: 'internal',
        }),
      ]);
      expect(rows(first, 'compiled-views')[0]).not.toHaveProperty('bytes');
      expect(rows(first, 'document-publications')).toEqual([
        expect.objectContaining({
          id: ids.publicationReceipt,
          action_id: ids.publicationAction,
          acceptance_action_id: ids.acceptanceAction,
          compiled_view_id: ids.compiledView,
          compiled_view_digest: compiledDigest,
          controlled_document_id: controlledDocumentObjectId,
          controlled_content_version_id: ids.compiledVersion,
          publication_target_id: ids.publicationTarget,
          publication_target_policy_digest: sha256(18),
        }),
      ]);

      const restored = await startHarness();
      try {
        await withTransaction(restored.adminPool, async (tx) =>
          importExport(tx, first, PRESERVATION_VERIFICATION),
        );
        const holderCycle = await withTransaction(restored.adminPool, (tx) =>
          tx.one<{ subjects: number; exact_links: number }>(
            `select count(*)::integer as subjects,
                    count(*) filter (where h.subject_id = s.id)::integer as exact_links
               from content.document_subject s
               join content.document_source_holder h on h.id = s.current_holder_id`,
          ),
        );
        expect(holderCycle).toEqual({ subjects: 2, exact_links: 2 });
        const second = authenticateExport(
          await withTransaction(restored.adminPool, async (tx) => createExport(tx)),
        );

        expect(second.manifest.counts).toEqual(first.manifest.counts);
        expect(exportIdentity(second.manifest)).toBe(exportIdentity(first.manifest));
        const before = new Map(first.files.map((entry) => [entry.path, entry.content]));
        for (const exported of second.files) {
          if (exported.path === 'manifest.json') continue;
          expect(exported.content, `${exported.path} differs after round trip`).toBe(
            before.get(exported.path),
          );
        }
      } finally {
        await restored.stop();
      }
    } finally {
      await source.stop();
    }
  }, 300_000);
});
