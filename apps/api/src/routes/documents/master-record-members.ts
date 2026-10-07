import type { MasterRecordManifest, PermissionMember } from '@kf/documents';
import { recordVerification, type RecordVerification } from '@kf/domain';
import type { ProjectionMember } from '@kf/projections';

/** Verification comes from live permitted records, never the immutable claim's old label. */
export function liveVerifications(
  permitted: readonly PermissionMember[],
): ReadonlyMap<string, RecordVerification> {
  return new Map(
    permitted.map((member) => [
      member.objectId,
      recordVerification(
        member.verified === undefined
          ? undefined
          : {
              basis: member.verified.basis,
              verifiedAt: member.verified.at,
              verifiedBy: member.verified.by,
              policyId: member.verified.policyId ?? null,
            },
      ),
    ]),
  );
}

/** Preserve manifest facts exactly; only verification is replaced by its live visible reading. */
export function projectionMembersOf(
  manifest: Pick<MasterRecordManifest, 'included' | 'withdrawn'>,
  verifications: ReadonlyMap<string, RecordVerification>,
): ProjectionMember[] {
  const map = (member: PermissionMember, itemState: 'included' | 'withdrawn'): ProjectionMember => {
    const envelope = member.content?.['core.object'];
    const state =
      typeof envelope === 'object' && envelope !== null
        ? (envelope as { lifecycle_state?: unknown }).lifecycle_state
        : undefined;
    const verification = itemState === 'included' ? verifications.get(member.objectId) : undefined;
    return {
      objectId: member.objectId,
      objectType: member.objectType,
      organizationId: member.organizationId,
      classification: member.classification,
      contentDigest: member.contentDigest,
      itemState,
      verification: verification ?? recordVerification(undefined, { visible: false }),
      ...(typeof state === 'string' ? { lifecycleState: state } : {}),
      ...(member.title === undefined ? {} : { title: member.title }),
      ...(member.content === undefined ? {} : { content: member.content }),
      ...(member.withdrawnAt === undefined ? {} : { withdrawnAt: member.withdrawnAt }),
      ...(member.withdrawalReason === undefined
        ? {}
        : { withdrawalReason: member.withdrawalReason }),
    };
  };
  return [
    ...manifest.included.map((m) => map(m, 'included')),
    ...manifest.withdrawn.map((m) => map(m, 'withdrawn')),
  ];
}
