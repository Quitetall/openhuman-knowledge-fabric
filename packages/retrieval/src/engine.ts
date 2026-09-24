/**
 * Semantic ranking for one query, fail closed (§64A, KF-SAS-RQ-214 to RQ-216).
 *
 * Holds the band bitmaps an engine was last given, in memory, keyed by the organization and
 * checked against `(band_version, generation)` on every query. Nothing here outlives the process
 * (KF-SAS-RQ-223): the cache is a `Map`, and the package's own test refuses a filesystem import or
 * a write statement anywhere in it.
 */

import { coveringGrants, type AccessCoverage } from '@kf/authorization';
import type { Tx } from '@kf/database';
import type { RetrievalClient } from './client.js';
import { type RetrievalOutcome, type Unavailable } from './client.js';
import {
  BANDS,
  BandVersionMoved,
  buildBandBitmaps,
  currentBandVersion,
  type Band,
  type BandBitmaps,
} from './index.js';

/**
 * Runs `fn` in a short transaction of its own, with the caller's access context bound.
 *
 * Semantic ranking alternates between the database and the engine, and a transaction must not
 * stay open while the engine works: a snapshot held across an embedding round trip is the bloat
 * ADR 0028 refused to put inside PostgreSQL. So each database step is its own transaction, and
 * every engine exchange happens between them.
 */
export type TransactionRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface SemanticQuery {
  readonly organizationId: string;
  /** The caller's clearance: the session ceiling row security already applies. */
  readonly clearance: string;
  /** The caller's read grants, resolved once for the request. */
  readonly coverage: AccessCoverage;
  readonly query: string;
  readonly k: number;
}

/** What the engine is told to score, for one caller. Derived per query; never stored. */
export interface EngineScope {
  readonly ceiling: Band | 'none';
  readonly allow: readonly string[];
}

function rank(band: string): number {
  return (BANDS as readonly string[]).indexOf(band);
}

/**
 * The caller's grants, reduced to what the engine's mask takes.
 *
 * The ceiling is the highest band at or below the caller's clearance that an organization-wide
 * grant reaches — not the clearance itself, because access is a grant on every read (ADR 0016,
 * ADR 0027) and a clearance alone reads nothing. When no organization-wide grant reaches any band
 * the ceiling is `none`, and only the allow list is scorable.
 *
 * The allow list is every object an object-scoped grant reaches whose classification the caller's
 * row security shows at or below the clearance. An object above the clearance is not visible to
 * the query that reads classifications, so it never enters the list whatever the grant says.
 */
export async function engineScope(
  tx: Tx,
  clearance: string,
  coverage: AccessCoverage,
): Promise<EngineScope> {
  const clearanceRank = rank(clearance);
  let ceiling: Band | 'none' = 'none';
  for (const band of BANDS) {
    if (rank(band) > clearanceRank) break;
    // An organization-wide grant reaches every object in the band; `coveringGrants` answers for
    // an id no object-scoped grant names, so only the organization-wide grants are consulted.
    if (coveringGrants({ ...coverage, byObject: new Map() }, '', band).length > 0) ceiling = band;
  }

  const named = [...coverage.byObject.keys()];
  if (named.length === 0) return { ceiling, allow: [] };
  const rows = await tx.query<{ id: string; classification: string }>(
    'select /* retrieval.allow-classifications */ id, classification from core.object where id = any($1::uuid[])',
    [named],
  );
  const allow = rows
    .filter(
      (row) =>
        rank(row.classification) >= 0 &&
        rank(row.classification) <= clearanceRank &&
        coveringGrants(coverage, row.id, row.classification).length > 0,
    )
    .map((row) => row.id)
    .sort();
  return { ceiling, allow };
}

function unavailable(reason: string, rebuildBands = false): Unavailable {
  return { status: 'unavailable', reason, rebuildBands };
}

export class SemanticRetrieval {
  /** Bitmaps last pushed, per organization. Memory only (KF-SAS-RQ-223). */
  private readonly pushed = new Map<string, BandBitmaps>();

  constructor(readonly client: RetrievalClient) {}

  /**
   * Rank one query, or say why not. Never a partial list: every failure is `unavailable`.
   *
   * One retry, and only for an engine that reports it has lost or outgrown the bands it was
   * given — it restarted, or its index moved — because that is fixed by pushing them again and
   * says nothing about whether it can serve.
   */
  async rank(run: TransactionRunner, query: SemanticQuery): Promise<RetrievalOutcome> {
    const first = await this.attempt(run, query);
    if (first.status === 'unavailable' && first.rebuildBands) {
      this.pushed.delete(query.organizationId);
      return this.attempt(run, query);
    }
    return first;
  }

  private async attempt(run: TransactionRunner, query: SemanticQuery): Promise<RetrievalOutcome> {
    const bitmaps = await this.current(run, query.organizationId);
    if ('status' in bitmaps) return bitmaps;
    const scope = await run((tx) => engineScope(tx, query.clearance, query.coverage));
    // No transaction is open from here until the engine answers.
    const outcome = await this.client.search({
      organizationId: query.organizationId,
      bandVersion: bitmaps.bandVersion.toString(),
      generation: bitmaps.generation,
      ceiling: scope.ceiling,
      allow: scope.allow,
      deny: [],
      query: query.query,
      k: query.k,
    });
    if (outcome.status === 'unavailable' && outcome.rebuildBands) {
      this.pushed.delete(query.organizationId);
    }
    return outcome;
  }

  /** Bitmaps the engine holds for the organization's current band version, pushing if needed. */
  private async current(
    run: TransactionRunner,
    organizationId: string,
  ): Promise<BandBitmaps | Unavailable> {
    const version = await run((tx) => currentBandVersion(tx, organizationId));
    const cached = this.pushed.get(organizationId);
    if (cached !== undefined && cached.bandVersion === version) return cached;

    const slots = await this.client.slots();
    if (slots.status === 'unavailable') return slots;
    let bitmaps: BandBitmaps;
    try {
      bitmaps = await run((tx) =>
        buildBandBitmaps(tx, organizationId, {
          generation: slots.generation,
          objectIds: slots.objectIds,
        }),
      );
    } catch (error) {
      if (error instanceof BandVersionMoved) return unavailable(error.message, true);
      throw error;
    }
    const pushed = await this.client.pushBands(bitmaps);
    if ('status' in pushed) return pushed;
    this.pushed.set(organizationId, bitmaps);
    return bitmaps;
  }
}
