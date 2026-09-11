/**
 * Access is a grant (ADR 0016), on every read surface.
 *
 * Row-level security decides what a session may SEE: this organization, up to the caller's
 * clearance. A grant decides what a person may READ: an organization-wide grant through a
 * role assignment (capped by that assignment's ceiling), a project membership, or an
 * object-scoped `grant_access`. Until 2026-09-11 only the master record checked the grant;
 * a document, its bytes, its workbench and a search hit were served on row-level security
 * alone, which is why the role ceiling had to cap the whole session and an object grant
 * above it could never be reached. Now the session ceiling is the clearance, and every read
 * surface asks the same question the master record asks.
 *
 * The answer is computed once per request from `org.effective_access_grant` and applied to
 * each object's classification; there is no second policy here, only the same one applied.
 */

import { coveringGrants, enumerateAccessCoverage, type AccessCoverage } from '@kf/authorization';
import type { Tx } from '@kf/database';

export interface ReadIdentity {
  readonly actorId: string;
  readonly organizationId: string;
}

export interface Classified {
  readonly id: string;
  readonly classification: string;
}

export async function readCoverage(tx: Tx, identity: ReadIdentity): Promise<AccessCoverage> {
  return enumerateAccessCoverage(tx, identity.actorId, identity.organizationId, 'read');
}

export function reaches(coverage: AccessCoverage, object: Classified): boolean {
  return coveringGrants(coverage, object.id, object.classification).length > 0;
}

/** The classification of every named object the session can see; unseen ids are absent. */
export async function classificationsOf(
  tx: Tx,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ id: string; classification: string }>(
    'select /* read-grant.classifications */ id, classification from core.object where id = any($1::uuid[])',
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.classification]));
}

/**
 * Whether this person may read this one object. False when the object is not visible to the
 * session at all, so a caller can answer `not_found` either way without distinguishing —
 * which it must not: the difference between "no such record" and "not yours" is itself
 * information.
 */
export async function readGranted(
  tx: Tx,
  identity: ReadIdentity,
  objectId: string,
): Promise<boolean> {
  const classification = (await classificationsOf(tx, [objectId])).get(objectId);
  if (classification === undefined) return false;
  const coverage = await readCoverage(tx, identity);
  return reaches(coverage, { id: objectId, classification });
}

/** The subset of `items` a grant reaches, in the order given. */
export async function readGrantedSubset<T extends { readonly id: string }>(
  tx: Tx,
  identity: ReadIdentity,
  items: readonly T[],
): Promise<T[]> {
  if (items.length === 0) return [];
  const [classifications, coverage] = await Promise.all([
    classificationsOf(
      tx,
      items.map((item) => item.id),
    ),
    readCoverage(tx, identity),
  ]);
  return items.filter((item) => {
    const classification = classifications.get(item.id);
    return classification !== undefined && reaches(coverage, { id: item.id, classification });
  });
}
