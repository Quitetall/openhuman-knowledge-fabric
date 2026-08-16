import type { Tx } from '@kf/database';
import type { ProjectionPages } from './contracts.js';
import { readRunProjectionData, type RunProjectionData } from './run-projection-data.js';

type RunPromotionReceipt = RunProjectionData['visiblePromotions'][number] & {
  readonly status: 'recorded' | 'revoked';
};

interface RunProjectionResponse {
  readonly schemaVersion: 'kf.ml.run-projection.v1';
  readonly run: RunProjectionData['lineage']['run'];
  readonly lineage: {
    readonly lineageDigest: string;
    readonly recordedAt: string;
    readonly code: RunProjectionData['lineage']['code'];
    readonly recipe: RunProjectionData['lineage']['recipe'];
    readonly environment: RunProjectionData['lineage']['environment'];
    readonly metricPolicy: RunProjectionData['lineage']['metricPolicy'];
    readonly members: {
      readonly items: RunProjectionData['visibleMembers'];
      readonly page: {
        readonly limit: number;
        readonly afterMember: string | null;
        readonly nextAfterMember: string | null;
      };
    };
  };
  readonly metrics: {
    readonly events: RunProjectionData['visibleEvents'];
    readonly page: {
      readonly limit: number;
      readonly afterSequence: string;
      readonly nextAfterSequence: string | null;
    };
  };
  readonly segments: {
    readonly items: RunProjectionData['visibleSegments'];
    readonly page: {
      readonly limit: number;
      readonly afterOrdinal: number;
      readonly nextAfterOrdinal: number | null;
    };
  };
  readonly seal: RunProjectionData['seal'];
  readonly promotions: {
    readonly receipts: readonly RunPromotionReceipt[];
    readonly page: {
      readonly limit: number;
      readonly afterReceiptDigest: string | null;
      readonly nextAfterReceiptDigest: string | null;
    };
  };
}

export async function readRunProjection(
  tx: Tx,
  authorityId: string,
  revisionId: string,
  pages: ProjectionPages,
): Promise<RunProjectionResponse | undefined> {
  const data = await readRunProjectionData(tx, authorityId, revisionId, pages);
  if (data === undefined) return undefined;

  const lastMember = data.visibleMembers[data.visibleMembers.length - 1];
  const lastSegment = data.visibleSegments[data.visibleSegments.length - 1];
  const lastPromotion = data.visiblePromotions[data.visiblePromotions.length - 1];

  return {
    schemaVersion: 'kf.ml.run-projection.v1',
    run: data.lineage.run,
    lineage: {
      lineageDigest: data.lineage.lineageDigest,
      recordedAt: data.lineage.recordedAt,
      code: data.lineage.code,
      recipe: data.lineage.recipe,
      environment: data.lineage.environment,
      metricPolicy: data.lineage.metricPolicy,
      members: {
        items: data.visibleMembers,
        page: {
          limit: pages.members.limit,
          afterMember: pages.members.after.token,
          nextAfterMember:
            data.hasMoreMembers && lastMember !== undefined
              ? `${lastMember.role}:${lastMember.ordinal}`
              : null,
        },
      },
    },
    metrics: {
      events: data.visibleEvents,
      page: {
        limit: pages.events.limit,
        afterSequence: pages.events.afterSequence,
        nextAfterSequence: data.hasMoreEvents ? data.lastVisibleSequence : null,
      },
    },
    segments: {
      items: data.visibleSegments,
      page: {
        limit: pages.segments.limit,
        afterOrdinal: pages.segments.afterOrdinal,
        nextAfterOrdinal:
          data.hasMoreSegments && lastSegment !== undefined ? lastSegment.ordinal : null,
      },
    },
    seal: data.seal,
    promotions: {
      receipts: data.visiblePromotions.map((promotion) => ({
        aliasId: promotion.aliasId,
        candidate: promotion.candidate,
        policy: promotion.policy,
        riskTier: promotion.riskTier,
        technicalAuthorityDecision: promotion.technicalAuthorityDecision,
        qualityAuthorityDecision: promotion.qualityAuthorityDecision,
        promotedAt: promotion.promotedAt,
        signingKeyId: promotion.signingKeyId,
        receiptDigest: promotion.receiptDigest,
        signature: promotion.signature,
        // This is deliberately receipt-local. RLS may hide a newer receipt, so this route
        // cannot safely claim that a visible unrevoked receipt is the governed alias winner.
        status: promotion.revocation === null ? 'recorded' : 'revoked',
        revocation: promotion.revocation,
      })),
      page: {
        limit: pages.promotions.limit,
        afterReceiptDigest: pages.promotions.afterReceiptDigest,
        nextAfterReceiptDigest:
          data.hasMorePromotions && lastPromotion !== undefined
            ? lastPromotion.receiptDigest
            : null,
      },
    },
  };
}
