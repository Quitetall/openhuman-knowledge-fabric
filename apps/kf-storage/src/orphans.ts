/**
 * Collect evidence bytes that no record references.
 *
 * The object store sits outside the database transaction, so an ingest stores its bytes and
 * THEN dispatches the act. When the act is refused — no authority, a classification above the
 * ceiling, a parser refusal, a crash between the two — the bytes stay, under a key nothing
 * points at, forever. The ingest route now rehearses its refusals before the put, which makes
 * this rare; it cannot make it impossible, because the act still repeats every check after.
 *
 * WHAT IS CANDIDATE. Only keys under this organization's evidence prefixes
 * (`ingest/<org>/`, `document-imports/<org>/`, see `evidenceStorageKey` in @kf/documents),
 * whose current version is older than the grace period. The grace period covers an ingest in
 * flight: its bytes exist a moment before its act commits.
 *
 * WHAT IS REFERENCED. Any `content.artifact_version.storage_uri` or
 * `content.artifact_location.uri` equal to the key, including durable copies. That read is
 * under row-level security, so an artifact above the actor's ceiling would be INVISIBLE and its
 * bytes would look orphaned. The sweep therefore refuses to run unless the bound ceiling is
 * the top of the classification registry — checked by asking the database, not by trusting
 * the configured label.
 *
 * THE RACE THAT REMAINS. Between the reference check and the delete, an ingest of the same
 * bytes can reuse the existing object (`putIfAbsent` returns it) and commit a version pointing
 * at it. The window is one round trip, and it is detected rather than hidden: the reference is
 * checked again after the delete, and a key that became referenced is reported as a refusal,
 * which makes the run exit non-zero and names the digest to re-ingest.
 */

import type { SweepableObjectStore } from '@kf/artifacts';
import { bindPrincipal, withTransaction, type Pool } from '@kf/database';
import { assertServiceActor, type StorageActor } from './sweep.js';

/** Mirrors `EVIDENCE_KEY_NAMESPACES` in @kf/documents; a test holds the two equal. */
export const EVIDENCE_NAMESPACES = ['ingest', 'document-imports'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrphanSweepOptions {
  /** Keys younger than this are never collected. At least one hour. */
  readonly graceHours: number;
  /** Cap per run on keys removed, so a first run over a large backlog is bounded. */
  readonly limit?: number;
  readonly now?: Date;
}

export interface OrphanSweepReport {
  readonly collected: readonly string[];
  readonly kept: number;
  readonly refused: readonly { subject: string; reason: string }[];
}

async function referenced(pool: Pool, actor: StorageActor, key: string): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    await bindPrincipal(tx, {
      actorId: actor.personId,
      actingRoleId: actor.roleAssignmentId,
      organizationId: actor.organizationId,
      maxClassification: actor.maxClassification,
    });
    const row = await tx.one<{ referenced: boolean }>(
      `select exists (select 1 from content.artifact_version where storage_uri = $1)
           or exists (select 1 from content.artifact_location where uri = $1) as referenced`,
      [key],
    );
    return row.referenced;
  });
}

async function assertFullCeiling(pool: Pool, actor: StorageActor): Promise<void> {
  const full = await withTransaction(pool, async (tx) => {
    await bindPrincipal(tx, {
      actorId: actor.personId,
      actingRoleId: actor.roleAssignmentId,
      organizationId: actor.organizationId,
      maxClassification: actor.maxClassification,
    });
    return tx.one<{ full: boolean }>(
      `select core.current_classification_rank()
                >= (select max(rank) from registry.classification) as full`,
    );
  });
  if (!full.full) {
    throw new Error(
      'orphan collection needs the storage actor bound at the highest classification: ' +
        'below it, records it cannot see would make their bytes look unreferenced',
    );
  }
}

export async function sweepOrphanedEvidence(
  pool: Pool,
  store: SweepableObjectStore,
  actor: StorageActor,
  options: OrphanSweepOptions,
): Promise<OrphanSweepReport> {
  if (!Number.isFinite(options.graceHours) || options.graceHours < 1) {
    throw new Error('graceHours must be at least 1: an ingest in flight has bytes before its act');
  }
  // Interpolated into a prefix, so a stray `/` would widen the sweep to another prefix.
  if (!UUID.test(actor.organizationId)) throw new Error('organization id must be a UUID');
  await assertServiceActor(pool, actor);
  await assertFullCeiling(pool, actor);

  const limit = options.limit ?? 500;
  const cutoff = (options.now ?? new Date()).getTime() - options.graceHours * 3_600_000;
  const collected: string[] = [];
  const refused: { subject: string; reason: string }[] = [];
  let kept = 0;

  for (const namespace of EVIDENCE_NAMESPACES) {
    for await (const object of store.list(`${namespace}/${actor.organizationId}/`)) {
      if (collected.length >= limit) break;
      if (object.lastModified.getTime() >= cutoff || (await referenced(pool, actor, object.key))) {
        kept += 1;
        continue;
      }
      try {
        await store.deleteEveryVersion(object.key);
      } catch (error: unknown) {
        refused.push({
          subject: `object ${object.key}`,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (await referenced(pool, actor, object.key)) {
        refused.push({
          subject: `object ${object.key}`,
          reason: 'became referenced while being collected; re-ingest these bytes',
        });
        continue;
      }
      collected.push(object.key);
    }
  }
  return { collected, kept, refused };
}
