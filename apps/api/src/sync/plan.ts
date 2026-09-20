import { isAbsolute, normalize, relative } from 'node:path';

/**
 * What a sync would do, decided before anything happens (§48A, KF-SAS-RQ-227).
 *
 * Pure: no database, no filesystem, no network. The same reason `apps/api/src/ingest/plan.ts` is
 * pure — a refusal that arrives after half a batch has been written is not a refusal, it is a
 * partial application with an error message.
 *
 * **One gesture, many acts, never one act covering many.** That is the rule this planner exists
 * to make unexpressible. It emits one item per changed file; it never emits a "sync this folder"
 * item, because that is the container decision KF-SAS-RQ-021 forbids, and a ledger carrying one
 * entry where two hundred judgements were made cannot answer who decided what.
 */

/** One file as the local copy has it. */
export interface LocalFile {
  /** Path relative to the sync root, using forward slashes. */
  readonly path: string;
  readonly digest: string;
}

/** One record as the downloaded projection had it, with the object it came from. */
export interface ProjectedFile {
  readonly path: string;
  readonly digest: string;
  readonly objectId: string;
  /** The row version the projection was compiled at; a write pins it. */
  readonly rowVersion: string;
}

export interface SyncRequest {
  readonly local: readonly LocalFile[];
  readonly projected: readonly ProjectedFile[];
  /**
   * The classification every added record takes.
   *
   * Required, never inferred. Defaulting it either over-discloses the batch or hides it from the
   * person who needed it, and the safe-looking choice — the syncing person's own ceiling — is
   * still a decision, so it is theirs to state rather than this planner's to assume.
   */
  readonly classification?: string;
  /**
   * Above this many items the batch is refused unless overridden.
   *
   * Point a sync at the wrong directory and it proposes ten thousand acts. The ceiling makes that
   * a refusal a person reads rather than a ledger they discover.
   */
  readonly bulkCeiling?: number;
  readonly acceptBulk?: boolean;
}

export type SyncAct =
  | { readonly kind: 'add'; readonly path: string; readonly digest: string }
  | {
      readonly kind: 'update';
      readonly path: string;
      readonly digest: string;
      readonly objectId: string;
      readonly pinnedRowVersion: string;
    }
  | {
      readonly kind: 'propose_withdrawal';
      readonly path: string;
      readonly objectId: string;
      readonly pinnedRowVersion: string;
    };

export type SyncPlan =
  | {
      readonly ok: true;
      readonly classification: string;
      readonly acts: readonly SyncAct[];
    }
  | { readonly ok: false; readonly refusals: readonly string[] };

export const DEFAULT_BULK_CEILING = 250;

/** A path that leaves the sync root, or is absolute, names something the caller did not offer. */
function escapesRoot(path: string): boolean {
  if (isAbsolute(path)) return true;
  const normalized = normalize(path);
  return normalized.startsWith('..') || relative('.', normalized).startsWith('..');
}

/**
 * Refuses the whole batch on every problem found, so one run tells the caller everything.
 *
 * Nothing is applied partially: a sync that wrote two hundred acts and then refused the two
 * hundred and first would leave a corpus nobody chose.
 */
export function planSync(request: SyncRequest): SyncPlan {
  const refusals: string[] = [];

  if (request.classification === undefined) {
    refusals.push(
      'no classification given. Every record admitted by this sync needs a ceiling, and the ' +
        "obvious default — the syncing person's own — is still a decision somebody has to make.",
    );
  }

  for (const file of [...request.local, ...request.projected]) {
    if (escapesRoot(file.path)) {
      refusals.push(`path leaves the sync root: ${file.path}`);
    }
  }

  const seen = new Set<string>();
  for (const file of request.local) {
    if (seen.has(file.path)) refusals.push(`local copy lists ${file.path} twice`);
    seen.add(file.path);
  }

  const projectedByPath = new Map(request.projected.map((file) => [file.path, file]));
  const localByPath = new Map(request.local.map((file) => [file.path, file]));

  const acts: SyncAct[] = [];
  for (const file of request.local) {
    const was = projectedByPath.get(file.path);
    if (was === undefined) {
      acts.push({ kind: 'add', path: file.path, digest: file.digest });
    } else if (was.digest !== file.digest) {
      acts.push({
        kind: 'update',
        path: file.path,
        digest: file.digest,
        objectId: was.objectId,
        // Pinned, so a record that moved while the copy was offline refuses the write rather
        // than clobbering a decision somebody else made in between.
        pinnedRowVersion: was.rowVersion,
      });
    }
  }
  for (const file of request.projected) {
    if (localByPath.has(file.path)) continue;
    // Law 6 has no delete. A file removed locally proposes a withdrawal, which is a recorded
    // state change somebody decides on, not an absence the sync enacts.
    acts.push({
      kind: 'propose_withdrawal',
      path: file.path,
      objectId: file.objectId,
      pinnedRowVersion: file.rowVersion,
    });
  }

  const ceiling = request.bulkCeiling ?? DEFAULT_BULK_CEILING;
  if (acts.length > ceiling && request.acceptBulk !== true) {
    refusals.push(
      `this sync would dispatch ${String(acts.length)} acts, above the ceiling of ` +
        `${String(ceiling)}. A sync pointed at the wrong directory looks exactly like this one. ` +
        'Confirm the batch explicitly if it is what you meant.',
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    classification: request.classification as string,
    acts: acts.sort((left, right) => left.path.localeCompare(right.path, 'en')),
  };
}
