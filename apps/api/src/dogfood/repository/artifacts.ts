import { verifyRecordedVersion, type ObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';
import type { DogfoodArtifactClaim, LegacyArtifactMaterialization } from './contracts.js';
import { isTrustedPreSemanticAction } from './legacy-actions.js';

export async function artifactVersionCreatedByAction(
  tx: Tx,
  organizationId: string,
  artifactId: string,
  actionId: string,
): Promise<{ readonly id: string }> {
  return tx.one<{ id: string }>(
    `select version.id
       from content.artifact_version version
       join core.object object on object.id = version.artifact_id
      where version.artifact_id = $1 and version.created_by_action = $2
        and object.organization_id = $3`,
    [artifactId, actionId, organizationId],
  );
}

/**
 * Reuse one exact materialized artifact whose action predates semantic request digests.
 *
 * Migration 019 deliberately made those actions non-replayable. This is not action replay:
 * it recognizes an audited, byte-exact result so the local loader does not attempt a second
 * mutation. Current semantic actions still pass through the dispatcher unchanged.
 */
export async function legacyArtifactMaterialization(
  tx: Tx,
  store: ObjectStore,
  organizationId: string,
  actorId: string,
  idempotencyKey: string,
  claim: DogfoodArtifactClaim,
): Promise<{ readonly artifactId: string; readonly versionId: string } | undefined> {
  const row = await tx.maybeOne<LegacyArtifactMaterialization>(
    `/* dogfood.legacy-artifact-materialization */
     select action.id as "actionId", action.request_digest as "requestDigest",
            action.result_status as "resultStatus",
            action.result ->> 'audit_digest' as "resultAuditDigest",
            action.action_type as "actionType", action.actor_id as "actorId",
            action.acting_role_id as "actingRoleId", action.target_ids as "targetIds",
            to_char(event.effective_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveAt",
            event.before_digest as "beforeDigest", event.after_digest as "afterDigest",
            event.prev_digest as "prevDigest",
            event.digest as "auditDigest",
            artifact.id as "artifactId", version.id as "versionId",
            version.storage_uri as "storageUri", version.storage_version as "storageVersion"
       from core.action action
       join core.action_migration019_legacy legacy on legacy.action_id = action.id
       join core.audit_event event on event.action_id = action.id
       join lateral (
         select target.id from unnest(action.target_ids) with ordinality target(id, ordinal)
          order by target.ordinal limit 1
       ) first_target on true
       join core.object object on object.id = first_target.id
       join content.artifact artifact on artifact.id = object.id
       join content.artifact_version version
         on version.artifact_id = artifact.id and version.created_by_action = action.id
      where action.organization_id = $1 and action.actor_id = $2
        and action.action_type = 'attach_evidence' and action.idempotency_key = $3
        and action.result_status = 'applied'
        and action.result ->> 'audit_digest' = event.digest
        and event.actor_id = action.actor_id
        and event.acting_role_id = action.acting_role_id
        and event.action_type = action.action_type
        and event.effective_at = action.effective_at
        and event.request_id is not distinct from action.request_id
        and event.reason is not distinct from action.reason
        and event.object_id = first_target.id
        and (select count(*) from core.audit_event exact_event
              where exact_event.action_id = action.id) = 1
        and cardinality(action.target_ids) = 1
        and object.organization_id = $1 and object.title = $4
        and artifact.artifact_kind = $5 and artifact.source_system = 'object_store'
        and version.sha256 = $6 and version.size_bytes = $7
        and version.media_type = $8 and version.storage_uri = $9
        and version.revision_label is not distinct from $10
        and version.created_by = $2
        and (
          not $11
          or exists (
            select 1 from content.document_parse parse
             where parse.artifact_version_id = version.id
               and parse.created_by_action = action.id
          )
        )`,
    [
      organizationId,
      actorId,
      idempotencyKey,
      claim.title,
      claim.artifactKind,
      claim.sha256,
      claim.sizeBytes,
      claim.mediaType,
      claim.storageUri,
      claim.revisionLabel ?? null,
      claim.requiresDocumentParse,
    ],
  );
  if (row === undefined || !isTrustedPreSemanticAction(row)) return undefined;
  try {
    const verification = await verifyRecordedVersion(store, {
      sha256: claim.sha256,
      sizeBytes: claim.sizeBytes,
      storageUri: row.storageUri,
      storageVersion: row.storageVersion,
    });
    if (!verification.ok) {
      throw new Error(`${verification.failure}: ${verification.detail}`);
    }
  } catch (error: unknown) {
    throw new Error(
      `Dogfood loader cannot reuse legacy artifact ${row.versionId}: pinned bytes failed verification.`,
      {
        cause: error,
      },
    );
  }
  return { artifactId: row.artifactId, versionId: row.versionId };
}
