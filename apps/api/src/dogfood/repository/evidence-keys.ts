import { semanticActionRequestDigest, type ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';

/**
 * Where a development database loaded before 2026-09-23 recorded its document bytes.
 *
 * `attach_evidence` keys used to be `document-imports/<sha256>`, shared by every organization;
 * they are now `document-imports/<organization>/<sha256>` (`evidenceStorageKey`). The recorded
 * versions still point at the old keys and stay readable — readers take the key from the row.
 */
export function legacyEvidenceKey(sha256: string): string {
  return `document-imports/${sha256}`;
}

/** The one command that starts a development database over, for a conflict nothing else explains. */
export const DOGFOOD_RESET_COMMAND =
  'DATABASE_URL="$DATABASE_OWNER_URL" pnpm db:reset && pnpm dogfood:load -- --source-dir <dir>';

/**
 * The `storage_uri` an `attach_evidence` retry must carry so the dispatcher REPLAYS what this
 * loader already recorded, rather than refusing it as an idempotency conflict.
 *
 * Re-running `pnpm dogfood:load` is meant to be a no-op. After the storage key became
 * organization-scoped, a re-run against a database loaded before it built a payload differing
 * in exactly one field — the key — so every rerun died on `idempotency_conflict` and the only
 * advice was "reset your database". This asks the ledger what was recorded under the loader's
 * idempotency key and answers with the key that makes the request identical to it:
 *
 *   - nothing recorded, or recorded with today's key  -> today's key (a new act, or a replay);
 *   - recorded with the legacy unscoped key, and that is the ONLY difference -> the legacy key,
 *     so the dispatcher replays the recorded act. Replay happens before any materialization,
 *     so the key rule for new acts (KF-ART-KEY) is never bypassed: nothing new is written.
 *   - anything else -> refused here, naming the reset command, because the database holds an
 *     act this loader did not make and guessing which is right would be worse than stopping.
 */
export async function replayableEvidenceKey(
  tx: Tx,
  request: ActionRequest,
  sha256: string,
): Promise<string> {
  const payload = request.payload ?? {};
  const current = payload['storage_uri'];
  if (typeof current !== 'string') throw new Error('attach_evidence request has no storage_uri');
  const prior = await tx.maybeOne<{ requestDigest: string }>(
    `/* dogfood.prior-attach-evidence */
     select request_digest as "requestDigest" from core.action
      where organization_id = $1 and action_type = 'attach_evidence' and idempotency_key = $2`,
    [request.organizationId, request.idempotencyKey],
  );
  if (prior === undefined || prior.requestDigest === semanticActionRequestDigest(request)) {
    return current;
  }
  const legacy = legacyEvidenceKey(sha256);
  const asRecorded: ActionRequest = { ...request, payload: { ...payload, storage_uri: legacy } };
  if (prior.requestDigest === semanticActionRequestDigest(asRecorded)) return legacy;
  throw new Error(
    `Dogfood loader: ${request.idempotencyKey} was already recorded in this database for a ` +
      'different request than this loader makes, and not only because of the storage-key ' +
      `change it knows how to replay. Start the development database over: ${DOGFOOD_RESET_COMMAND}`,
  );
}
