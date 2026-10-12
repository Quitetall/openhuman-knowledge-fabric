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
 *
 * EVERY DELETION IS RECORDED (20260924000400). Right after the delete, before anything else,
 * `content.record_orphan_collection` appends the key, the store, how many versions went and why
 * to `content.orphan_collection`, attributed by the database to the bound service actor. That
 * table is append-only and exported; the journal line is no longer the only trail. A deletion
 * that could not be recorded is a refusal — the bytes are gone and the record is not, which is
 * the outcome that must fail the run rather than pass quietly.
 *
 * COMPILED VIEWS are swept by `sweepUnreferencedCompiledViews` below, under the same record and
 * the same rules, with the differences their shared, digest-only prefix forces (SAS §100.64).
 */

import { isAccessDenied, type SweepableObjectStore } from '@kf/artifacts';
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
  /** The `content.artifact_store` id of the store being swept. Defaults to `working`. */
  readonly storeId?: string;
  /**
   * Said instead of the store's bare "Access Denied." when it refuses this credential: which
   * permissions are missing and the command that grants them. The run still fails.
   */
  readonly accessDenied?: string;
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

/** Append the collection to `content.orphan_collection`; the database names who did it. */
async function recordCollection(
  pool: Pool,
  actor: StorageActor,
  entry: { storeId: string; key: string; versionsRemoved: number; reason: string },
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await bindPrincipal(tx, {
      actorId: actor.personId,
      actingRoleId: actor.roleAssignmentId,
      organizationId: actor.organizationId,
      maxClassification: actor.maxClassification,
    });
    await tx.one('select content.record_orphan_collection($1, $2, $3, $4) as id', [
      entry.storeId,
      entry.key,
      entry.versionsRemoved,
      entry.reason,
    ]);
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
  const storeId = options.storeId ?? 'working';
  const reason =
    `no artifact version or location referenced these bytes for ${String(options.graceHours)} ` +
    'hours (kf-storage --collect-orphans)';

  const explain = (error: unknown): string =>
    isAccessDenied(error) && options.accessDenied !== undefined
      ? options.accessDenied
      : error instanceof Error
        ? error.message
        : String(error);

  for (const namespace of EVIDENCE_NAMESPACES) {
    const prefix = `${namespace}/${actor.organizationId}/`;
    try {
      for await (const object of store.list(prefix)) {
        if (collected.length >= limit) break;
        if (
          object.lastModified.getTime() >= cutoff ||
          (await referenced(pool, actor, object.key))
        ) {
          kept += 1;
          continue;
        }
        let versionsRemoved: number;
        try {
          versionsRemoved = await store.deleteEveryVersion(object.key);
        } catch (error: unknown) {
          refused.push({ subject: `object ${object.key}`, reason: explain(error) });
          // The same refusal for every key after the first says nothing new; stop here.
          if (isAccessDenied(error)) return { collected, kept, refused };
          continue;
        }
        try {
          await recordCollection(pool, actor, {
            storeId,
            key: object.key,
            versionsRemoved,
            reason,
          });
        } catch (error: unknown) {
          refused.push({
            subject: `object ${object.key}`,
            reason:
              'deleted but NOT recorded in content.orphan_collection: ' +
              (error instanceof Error ? error.message : String(error)),
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
    } catch (error: unknown) {
      if (!isAccessDenied(error)) throw error;
      refused.push({ subject: `prefix ${prefix}`, reason: explain(error) });
      return { collected, kept, refused };
    }
  }
  return { collected, kept, refused };
}

/** Where the compiler runtime writes a view: its content address (`materializeViews`). */
export const COMPILED_VIEW_PREFIX = 'compiled-views/sha256/';

const COMPILED_VIEW_KEY = /^compiled-views\/sha256\/[0-9a-f]{64}$/u;

/**
 * Collect compiled views no record references (SAS §100.64).
 *
 * The compiler runtime writes a view's bytes and only then asks the database to record the run.
 * A run the database refuses as not reproducing an earlier one (KF-DOC-DETERMINISM-001) is
 * recorded as failed with no views, so what it wrote stays under a key nothing names; so does a
 * view whose run crashed between the write and the record. The same sweep as for evidence, with
 * two differences the prefix forces:
 *
 * ACROSS ORGANIZATIONS. A view's key is its digest alone, so organizations that compile the same
 * bytes share it, and a reference check under the collector's row security would call another
 * organization's view an orphan. `content.claim_unreferenced_compiled_view` checks every
 * organization, as a definer, for a bound service actor, and answers only yes or no.
 *
 * UNDER ONE LOCK PER KEY. The runtime adopts a key that already exists instead of writing it
 * again, so a compilation in flight can adopt a view a refused run left long ago, and the grace
 * period, which is the key's age, does not protect it. The claim, the delete and the record are
 * one transaction holding `content.lock_stored_key`; the runtime takes the same lock where it
 * records the run, and re-reads its views there. Whichever is second sees what the first did:
 * the sweep finds the key referenced and keeps it, or the runtime finds its version gone,
 * records nothing, and is retried, writing the view again.
 *
 * A deletion whose record then fails rolls the claim back but not the store: reported as a
 * refusal, as for evidence, because the bytes are gone and the record is not.
 */
export async function sweepUnreferencedCompiledViews(
  pool: Pool,
  store: SweepableObjectStore,
  actor: StorageActor,
  options: OrphanSweepOptions,
): Promise<OrphanSweepReport> {
  if (!Number.isFinite(options.graceHours) || options.graceHours < 1) {
    throw new Error(
      'graceHours must be at least 1: a compilation in flight has bytes before its run',
    );
  }
  await assertServiceActor(pool, actor);

  const limit = options.limit ?? 500;
  const cutoff = (options.now ?? new Date()).getTime() - options.graceHours * 3_600_000;
  const collected: string[] = [];
  const refused: { subject: string; reason: string }[] = [];
  let kept = 0;
  const storeId = options.storeId ?? 'working';
  const reason =
    `no artifact version or location in any organization referenced this compiled view for ` +
    `${String(options.graceHours)} hours (kf-storage --collect-orphans)`;
  const explain = (error: unknown): string =>
    isAccessDenied(error) && options.accessDenied !== undefined
      ? options.accessDenied
      : error instanceof Error
        ? error.message
        : String(error);

  try {
    for await (const object of store.list(COMPILED_VIEW_PREFIX)) {
      if (collected.length >= limit) break;
      // Anything else under the prefix is not a content address the runtime wrote; left alone.
      if (!COMPILED_VIEW_KEY.test(object.key) || object.lastModified.getTime() >= cutoff) {
        kept += 1;
        continue;
      }
      let deleted = false;
      try {
        const outcome = await withTransaction(pool, async (tx) => {
          await bindPrincipal(tx, {
            actorId: actor.personId,
            actingRoleId: actor.roleAssignmentId,
            organizationId: actor.organizationId,
            maxClassification: actor.maxClassification,
          });
          const claim = await tx.one<{ unreferenced: boolean }>(
            'select content.claim_unreferenced_compiled_view($1) as unreferenced',
            [object.key],
          );
          if (!claim.unreferenced) return 'kept' as const;
          const versionsRemoved = await store.deleteEveryVersion(object.key);
          deleted = true;
          await tx.one('select content.record_orphan_collection($1, $2, $3, $4) as id', [
            storeId,
            object.key,
            versionsRemoved,
            reason,
          ]);
          return 'collected' as const;
        });
        if (outcome === 'kept') kept += 1;
        else collected.push(object.key);
      } catch (error: unknown) {
        refused.push({
          subject: `object ${object.key}`,
          reason: deleted
            ? 'deleted but NOT recorded in content.orphan_collection: ' + explain(error)
            : explain(error),
        });
        if (isAccessDenied(error)) return { collected, kept, refused };
      }
    }
  } catch (error: unknown) {
    if (!isAccessDenied(error)) throw error;
    refused.push({ subject: `prefix ${COMPILED_VIEW_PREFIX}`, reason: explain(error) });
  }
  return { collected, kept, refused };
}
