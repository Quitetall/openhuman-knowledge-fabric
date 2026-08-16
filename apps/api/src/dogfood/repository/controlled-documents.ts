import type { Tx } from '@kf/database';
import type {
  DogfoodControlledDocumentClaim,
  LegacyControlledDocumentMaterialization,
} from './contracts.js';
import { isTrustedPreSemanticAction } from './legacy-actions.js';

/** Reuse one exact controlled-document result from a pre-semantic audited action. */
export async function legacyControlledDocumentMaterialization(
  tx: Tx,
  organizationId: string,
  actorId: string,
  idempotencyKey: string,
  claim: DogfoodControlledDocumentClaim,
): Promise<{ readonly documentId: string } | undefined> {
  const row = await tx.maybeOne<LegacyControlledDocumentMaterialization>(
    `/* dogfood.legacy-controlled-document-materialization */
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
            document.id as "documentId"
       from core.action action
       join core.action_migration019_legacy legacy on legacy.action_id = action.id
       join core.audit_event event on event.action_id = action.id
       join lateral (
         select target.id from unnest(action.target_ids) with ordinality target(id, ordinal)
          order by target.ordinal limit 1
       ) first_target on true
       join core.object object on object.id = first_target.id
       join quality.controlled_document document on document.id = object.id
      where action.organization_id = $1 and action.actor_id = $2
        and action.action_type = 'add_controlled_document' and action.idempotency_key = $3
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
        and document.document_class = $5 and document.document_number = $6
        and document.revision = $7 and document.owning_role = $8
        and document.content_version = $9`,
    [
      organizationId,
      actorId,
      idempotencyKey,
      claim.title,
      claim.documentClass,
      claim.documentNumber,
      claim.revision,
      claim.owningRole,
      claim.contentVersionId,
    ],
  );
  if (row === undefined || !isTrustedPreSemanticAction(row)) return undefined;
  return { documentId: row.documentId };
}
