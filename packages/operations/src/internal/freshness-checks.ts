import type { CheckFn } from './contracts.js';

export const outboxHealth: CheckFn = async (tx, limits) => {
  // `core.outbox` is organization-scoped for ordinary readers, but readiness has to report the
  // queue globally and has no person context to bind. The database definer returns only count
  // and age, so this check cannot become a cross-organization payload reader merely because it
  // is monitoring delivery.
  const row = await tx.one<{ pending: string; oldest_seconds: string }>(
    `select pending::text, oldest_seconds::text
       from core.readiness_outbox_backlog()`,
  );
  const pending = Number(row.pending);
  const age = Number(row.oldest_seconds);

  const behind = pending > limits.outboxPending || age > limits.outboxAgeSeconds;
  return {
    id: 'outbox_delivery',
    status: pending === 0 ? 'ok' : behind ? 'degraded' : 'ok',
    detail: behind
      ? `Delivery is behind: ${pending} pending, oldest ${age}s. Derived indexes are stale; no record is wrong.`
      : 'Delivery is current.',
    measured: { pending, oldestSeconds: age },
  };
};

/**
 * Is every record indexed — asked once per organization, inside that organization's scope.
 *
 * This check used to compare `count(*) from core.object` against `count(*) from
 * search.document` in one unscoped query. That was already wrong before row-level security
 * reached either table: `core.object` was scoped and `search.document` was not, so it
 * compared a filtered count against an unfiltered one and could not report a shortfall.
 * Once both were scoped it became vacuous instead — run with no context, 0 >= 0 is `ok`.
 *
 * The three ways to fix it are not equivalent. Running as the owner gives one honest global
 * comparison, at the cost of a scheduled component that can read every record in every
 * organization to produce a single integer. Running as one bound identity is honest for that
 * organization and structurally blind to all the others — a check that cannot fail for the
 * reason it exists. So: federate. Bind each organization in turn, compare inside its scope,
 * and report the union.
 *
 * What this component can do is therefore bounded by what it asks, not only by what it is
 * granted: it issues `count(*)` and nothing else. It can count records. It cannot read one.
 *
 * `core.readiness_organization_ids()` supplies the identifiers, and returns identifiers only —
 * the one thing a caller with no context yet cannot discover for itself.
 */
export const searchComplete: CheckFn = async (tx) => {
  const ceiling = await tx.maybeOne<{ id: string }>(
    'select id from registry.classification order by rank desc limit 1',
  );
  if (ceiling === undefined) {
    return {
      id: 'search_index',
      status: 'unknown',
      detail: 'No classification ladder is seeded, so no scope can be bound to count within.',
    };
  }

  // Aliased: a `setof uuid` function names its result column after the function, not `id`.
  const organizations = await tx.query<{ id: string }>(
    'select organization as id from core.readiness_organization_ids() as organization',
  );
  if (organizations.length === 0) {
    return {
      id: 'search_index',
      status: 'ok',
      detail: 'No organizations exist yet, so there is nothing to index.',
      measured: { organizations: 0, objects: 0, indexed: 0 },
    };
  }

  let objects = 0;
  let indexed = 0;
  const behind: string[] = [];
  for (const organization of organizations) {
    // Transaction-local, so each iteration replaces the last and none of it outlives this
    // check. The ceiling is the top of the ladder because a check that could not see
    // restricted records would report a clean index over the half of them it can see.
    await tx.query('select core.set_access_context($1, $2)', [organization.id, ceiling.id]);
    // Bound AND filtered, for the same reason `searchIn` keeps its predicate after
    // `search.document` gained row-level security. Binding alone is enough for a scoped role
    // and does nothing for a superuser — and a readiness process that happens to connect as
    // one would then count every organization's records once per organization and report
    // totals that are wrong by a factor of however many organizations exist. The verdict
    // would survive; the numbers underneath it would not, and those are what somebody reads.
    const row = await tx.one<{ objects: string; indexed: string }>(
      `select (select count(*) from core.object
                where organization_id = $1)::text as objects,
              (select count(*) from search.document
                where organization_id = $1)::text as indexed`,
      [organization.id],
    );
    const scopedObjects = Number(row.objects);
    const scopedIndexed = Number(row.indexed);
    objects += scopedObjects;
    indexed += scopedIndexed;
    if (scopedIndexed < scopedObjects) {
      behind.push(`${organization.id} (${scopedObjects - scopedIndexed})`);
    }
  }

  return {
    id: 'search_index',
    status: behind.length === 0 ? 'ok' : 'degraded',
    detail:
      behind.length === 0
        ? `Every record is indexed, across ${organizations.length} organization(s).`
        : `${objects - indexed} record(s) are not indexed and cannot be found by search, in ` +
          `${behind.length} organization(s): ${behind.join(', ')}. Run search.rebuild().`,
    // Named per organization rather than only in total: one organization entirely unindexed
    // and another over-counted would sum to a total that looks correct.
    measured: { organizations: organizations.length, objects, indexed, behind: behind.length },
  };
};

export const federationFreshness: CheckFn = async (tx, limits) => {
  const row = await tx.one<{ total: string; stale: string; never: string }>(
    `select count(*)::text as total,
            count(*) filter (where verified_at < now() - make_interval(days => $1))::text as stale,
            count(*) filter (where verified_at is null)::text as never
       from quality.federated_reference`,
    [limits.federationStaleDays],
  );
  const total = Number(row.total);
  const stale = Number(row.stale) + Number(row.never);
  if (total === 0) {
    return {
      id: 'federation_freshness',
      status: 'ok',
      detail: 'No federated references are recorded.',
      measured: { total: 0, stale: 0 },
    };
  }
  return {
    id: 'federation_freshness',
    status: stale === 0 ? 'ok' : 'degraded',
    detail:
      stale === 0
        ? 'Every federated reference has been re-verified recently.'
        : `${stale} federated reference(s) have not been re-verified in ${limits.federationStaleDays} days. Drift in another system would not yet have been noticed.`,
    measured: { total, stale },
  };
};
