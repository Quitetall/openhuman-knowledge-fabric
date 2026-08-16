import type { Tx } from '@kf/database';
import type { ProjectionPages } from '../contracts.js';
import { ProjectionError, refSelect } from '../projection.js';
import {
  decodeLineageMemberRow,
  decodeMetricEventRow,
  decodeMetricSegmentRow,
  decodePromotionRow,
  decodeRunLineageRow,
  decodeRunSealRow,
} from './decoders.js';
import type {
  LineageMemberRow,
  MetricEventRow,
  MetricSegmentRow,
  PromotionRow,
  RunLineageRow,
  RunProjectionData,
  RunSealRow,
} from './types.js';

export async function readRunProjectionData(
  tx: Tx,
  authorityId: string,
  revisionId: string,
  pages: ProjectionPages,
): Promise<RunProjectionData | undefined> {
  const rawLineage = await tx.maybeOne<RunLineageRow>(
    `/* ml.run-lineage */
     select lineage.id::text as lineage_id,
            lineage.lineage_sha256,
            lineage.recorded_at as lineage_recorded_at,
            ${refSelect('run_ref', 'run')},
            ${refSelect('code_ref', 'code')},
            ${refSelect('recipe_ref', 'recipe')},
            ${refSelect('environment_ref', 'environment')},
            ${refSelect('policy_ref', 'metric_policy')}
       from ml.run_lineage lineage
       join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
       join ml.aggregate_reference code_ref on code_ref.id = lineage.code_ref_id
       join ml.aggregate_reference recipe_ref on recipe_ref.id = lineage.recipe_ref_id
       join ml.aggregate_reference environment_ref on environment_ref.id = lineage.environment_ref_id
       join ml.aggregate_reference policy_ref on policy_ref.id = lineage.metric_policy_ref_id
      where run_ref.authority_id = $1
        and run_ref.revision_id = $2
        and run_ref.aggregate_kind = 'run'`,
    [authorityId, revisionId],
  );
  if (rawLineage === undefined) return undefined;
  const lineage = decodeRunLineageRow(rawLineage);
  if (lineage.run.authorityId !== authorityId || lineage.run.revisionId !== revisionId) {
    throw new ProjectionError('ML projection run does not match requested authority');
  }

  const members = (
    await tx.query<LineageMemberRow>(
      `/* ml.lineage-members */
     select member.member_role, member.ordinal,
            ${refSelect('member_ref', 'member')}
       from (
         select 'input'::text as member_role, ordinal, aggregate_ref_id
           from ml.run_lineage_input where run_lineage_id = $1::uuid
         union all
         select 'output'::text as member_role, ordinal, aggregate_ref_id
           from ml.run_lineage_output where run_lineage_id = $1::uuid
         union all
         select 'parent_model'::text as member_role, ordinal, aggregate_ref_id
           from ml.run_lineage_parent_model where run_lineage_id = $1::uuid
       ) member
       join ml.aggregate_reference member_ref on member_ref.id = member.aggregate_ref_id
      where case member.member_role when 'input' then 1 when 'output' then 2 else 3 end > $2
         or (
           case member.member_role when 'input' then 1 when 'output' then 2 else 3 end = $2
           and member.ordinal > $3
         )
      order by case member.member_role
                 when 'input' then 1 when 'output' then 2 else 3
               end, member.ordinal
      limit $4`,
      [
        lineage.lineageId,
        pages.members.after.roleOrder,
        pages.members.after.ordinal,
        pages.members.limit + 1,
      ],
    )
  ).map(decodeLineageMemberRow);
  const hasMoreMembers = members.length > pages.members.limit;
  const visibleMembers = members.slice(0, pages.members.limit);

  const events = (
    await tx.query<MetricEventRow>(
      `/* ml.metric-events */
     select event.sequence_no::text as sequence_no,
            event.recorded_at,
            event.status,
            definition.metric_id,
            definition.value_kind,
            definition.unit_id,
            event.numeric_value,
            event.enum_value,
            event.timestamp_value,
            event.event_sha256
       from ml.metric_event event
       join ml.metric_definition definition on definition.id = event.metric_definition_id
      where event.run_lineage_id = $1::uuid and event.sequence_no > $2::bigint
      order by event.sequence_no
      limit $3`,
      [lineage.lineageId, pages.events.afterSequence, pages.events.limit + 1],
    )
  ).map(decodeMetricEventRow);
  const hasMoreEvents = events.length > pages.events.limit;
  const visibleEvents = events.slice(0, pages.events.limit);
  const lastVisibleSequence =
    visibleEvents.length === 0
      ? pages.events.afterSequence
      : visibleEvents[visibleEvents.length - 1]!.sequence;

  const segments = (
    await tx.query<MetricSegmentRow>(
      `/* ml.metric-segments */
     select segment.ordinal,
            segment.first_sequence::text as first_sequence,
            segment.last_sequence::text as last_sequence,
            segment.event_count::text as event_count,
            segment.metadata_sha256,
            ${refSelect('segment_ref', 'segment')}
       from ml.metric_segment segment
       join ml.aggregate_reference segment_ref on segment_ref.id = segment.segment_ref_id
      where segment.run_lineage_id = $1::uuid
        and segment.ordinal > $2
      order by segment.ordinal
      limit $3`,
      [lineage.lineageId, pages.segments.afterOrdinal, pages.segments.limit + 1],
    )
  ).map(decodeMetricSegmentRow);
  const hasMoreSegments = segments.length > pages.segments.limit;
  const visibleSegments = segments.slice(0, pages.segments.limit);

  const rawSeal = await tx.maybeOne<RunSealRow>(
    `/* ml.run-seal */
     select seal.lineage_sha256,
            seal.segment_manifest_sha256,
            seal.event_count::text as event_count,
            seal.sealed_at,
            seal.signing_key_id,
            seal.seal_sha256,
            seal.recorded_at
       from ml.run_seal seal
      where seal.run_lineage_id = $1::uuid`,
    [lineage.lineageId],
  );
  const seal = rawSeal === undefined ? null : decodeRunSealRow(rawSeal);
  if (seal !== null && seal.lineageDigest !== lineage.lineageDigest) {
    throw new ProjectionError('ML projection seal does not match run lineage');
  }

  const promotions = (
    await tx.query<PromotionRow>(
      `/* ml.promotions */
     select receipt.alias_id,
            receipt.risk_tier,
            receipt.promoted_at,
            receipt.signing_key_id,
            receipt.receipt_sha256,
            receipt.signature,
            revocation.revoked_at,
            revocation.reason_code,
            ${refSelect('candidate_ref', 'candidate')},
            ${refSelect('policy_ref', 'policy')},
            ${refSelect('technical_ref', 'technical')},
            ${refSelect('quality_ref', 'quality')}
       from ml.promotion_receipt receipt
       join ml.run_seal seal on seal.id = receipt.run_seal_id
       join ml.aggregate_reference candidate_ref on candidate_ref.id = receipt.candidate_ref_id
       join ml.aggregate_reference policy_ref on policy_ref.id = receipt.policy_ref_id
       join ml.aggregate_reference technical_ref
         on technical_ref.id = receipt.technical_authority_decision_ref_id
       left join ml.aggregate_reference quality_ref
         on quality_ref.id = receipt.quality_authority_decision_ref_id
       left join ml.promotion_revocation revocation on revocation.receipt_id = receipt.id
      where seal.run_lineage_id = $1::uuid
        and ($2::text is null or receipt.receipt_sha256 > $2)
      order by receipt.receipt_sha256
      limit $3`,
      [lineage.lineageId, pages.promotions.afterReceiptDigest, pages.promotions.limit + 1],
    )
  ).map(decodePromotionRow);
  const hasMorePromotions = promotions.length > pages.promotions.limit;

  return {
    lineage,
    visibleMembers,
    hasMoreMembers,
    visibleEvents,
    hasMoreEvents,
    lastVisibleSequence,
    visibleSegments,
    hasMoreSegments,
    seal,
    visiblePromotions: promotions.slice(0, pages.promotions.limit),
    hasMorePromotions,
  };
}
