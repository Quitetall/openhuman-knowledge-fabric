/**
 * The storage sweep: replicate every version that lacks a copy in the durable store, and
 * re-verify every location whose last verification is older than the policy says (ADR 0017,
 * ADR 0020). Every write is a typed action dispatched under the service actor, so each copy
 * and each verification is an audited act by a named principal — nothing here touches a
 * table.
 *
 * Idempotent by construction: a version that already has a location in the target store is
 * not replicated again (the action would refuse it as recorded), and a location verified
 * inside the window is left alone. Run it twice and the second run does nothing.
 */

import type { ActionDispatcher, ActionRequest } from '@kf/actions';
import { setAccessContext, withTransaction, type Pool } from '@kf/database';

export interface StorageActor {
  readonly personId: string;
  readonly roleAssignmentId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
}

export interface SweepOptions {
  readonly replicateTo?: string;
  readonly verifyOlderThanDays?: number;
  /** Cap per run so a first run over a large corpus is bounded; the timer catches up. */
  readonly limit?: number;
}

export interface SweepReport {
  readonly replicated: readonly { versionId: string; artifactId: string; actionId: string }[];
  readonly verified: readonly {
    locationId: string;
    role: string;
    actionId: string;
    ok: boolean;
  }[];
  readonly refused: readonly { subject: string; reason: string }[];
}

interface Candidate extends Record<string, unknown> {
  readonly version_id: string;
  readonly artifact_id: string;
}

interface StaleLocation extends Record<string, unknown> {
  readonly location_id: string;
  readonly artifact_id: string;
  readonly role: string;
}

function request(
  actor: StorageActor,
  actionType: string,
  targetIds: readonly string[],
  payload: Record<string, string>,
  key: string,
  reason: string,
): ActionRequest {
  return {
    actionType,
    actorId: actor.personId,
    actingRoleId: actor.roleAssignmentId,
    organizationId: actor.organizationId,
    maxClassification: actor.maxClassification,
    targetIds: [...targetIds],
    idempotencyKey: key,
    reason,
    payload,
  };
}

export async function runStorageSweep(
  pool: Pool,
  execute: ActionDispatcher,
  actor: StorageActor,
  options: SweepOptions,
): Promise<SweepReport> {
  const limit = options.limit ?? 500;
  // The sweep acts only as a declared service actor (ADR 0020). A human person id here
  // would make every copy an act by a human at 03:30, which is the thing this exists to
  // prevent — refused before anything is dispatched.
  const kind = await withTransaction(pool, async (tx) => {
    await setAccessContext(tx, {
      organizationId: actor.organizationId,
      maxClassification: actor.maxClassification,
    });
    return tx.maybeOne<{ person_kind: string }>(
      'select person_kind from org.person where id = $1 and organization = $2',
      [actor.personId, actor.organizationId],
    );
  });
  if (kind?.person_kind !== 'service') {
    throw new Error(
      `KF_STORAGE_ACTOR ${actor.personId} is not a service actor of this organization; ` +
        'declare one with kf:declare-service-actor',
    );
  }
  const replicated: { versionId: string; artifactId: string; actionId: string }[] = [];
  const verified: { locationId: string; role: string; actionId: string; ok: boolean }[] = [];
  const refused: { subject: string; reason: string }[] = [];
  const day = new Date().toISOString().slice(0, 10);

  if (options.replicateTo !== undefined) {
    const store = options.replicateTo;
    const candidates = await withTransaction(pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: actor.organizationId,
        maxClassification: actor.maxClassification,
      });
      return tx.query<Candidate>(
        `select v.id as version_id, v.artifact_id
           from content.artifact_version v
           join content.artifact_location working
             on working.version_id = v.id and working.role = 'working'
          where not exists (
                  select 1 from content.artifact_location l
                   where l.version_id = v.id and l.store_id = $1)
          order by v.created_at, v.id
          limit $2`,
        [store, limit],
      );
    });
    for (const candidate of candidates) {
      try {
        const result = await execute(
          request(
            actor,
            'replicate_artifact_version',
            [candidate.artifact_id],
            { version_id: candidate.version_id, store_id: store, role: 'durable_copy' },
            `storage-replicate-${candidate.version_id}-${store}`,
            `scheduled replication to ${store}`,
          ),
        );
        replicated.push({
          versionId: candidate.version_id,
          artifactId: candidate.artifact_id,
          actionId: result.actionId,
        });
      } catch (error: unknown) {
        refused.push({
          subject: `version ${candidate.version_id}`,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (options.verifyOlderThanDays !== undefined) {
    const days = options.verifyOlderThanDays;
    const stale = await withTransaction(pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: actor.organizationId,
        maxClassification: actor.maxClassification,
      });
      return tx.query<StaleLocation>(
        `select l.id as location_id, v.artifact_id, l.role
           from content.artifact_location l
           join content.artifact_version v on v.id = l.version_id
          where l.role <> 'public_copy'
            and (l.verified_at is null or l.verified_at < now() - make_interval(days => $1))
          order by l.verified_at nulls first, l.id
          limit $2`,
        [days, limit],
      );
    });
    for (const location of stale) {
      try {
        const result = await execute(
          request(
            actor,
            'verify_artifact_location',
            [location.artifact_id],
            { location_id: location.location_id },
            `storage-verify-${location.location_id}-${day}`,
            `scheduled re-verification (older than ${String(days)} days)`,
          ),
        );
        // verify_artifact_location writes verified_sha256 inside the action's own transaction,
        // so this read sees the outcome of exactly that act.
        const outcome = await withTransaction(pool, async (tx) => {
          await setAccessContext(tx, {
            organizationId: actor.organizationId,
            maxClassification: actor.maxClassification,
          });
          return tx.one<{ ok: boolean }>(
            'select verified_sha256 is not null as ok from content.artifact_location where id = $1',
            [location.location_id],
          );
        });
        verified.push({
          locationId: location.location_id,
          role: location.role,
          actionId: result.actionId,
          ok: outcome.ok,
        });
      } catch (error: unknown) {
        refused.push({
          subject: `location ${location.location_id}`,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { replicated, verified, refused };
}
