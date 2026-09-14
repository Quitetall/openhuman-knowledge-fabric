/**
 * The authorization mask a retrieval engine scores under (§64A, KF-SAS-RQ-213 to RQ-215, RQ-223).
 *
 * The retrieval index holds a vector and an object identifier. It holds no record text and no
 * authorization input, so it cannot decide who may read what — and that is the point: a copy of
 * an authorization decision goes stale, and a stale copy of THAT decision is a disclosure rather
 * than a wrong answer. The decision is therefore taken here, against live records, once per query,
 * and crosses to the engine as a mask over its slot ordering.
 *
 * Two things make that affordable. A caller's read authority reduces to a ceiling over four bands
 * plus a small explicit allow map (`AccessCoverage`), resolved in one query per request. And band
 * membership is a property of the organization rather than of the caller, so the same four bitmaps
 * serve everyone and can be cached against a version that moves whenever a classification does.
 *
 * The cache is memory-only, and that is a requirement rather than a convenience (KF-SAS-RQ-223).
 * Written to disk it becomes a durable copy of an authorization input, which is the category this
 * whole design exists to eliminate.
 */

import { coveringGrants, type AccessCoverage } from '@kf/authorization';
import type { Tx } from '@kf/database';

/** The four bands, lowest first. The order is the rank order and is relied upon. */
export const BANDS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Band = (typeof BANDS)[number];

/**
 * The engine's slot ordering, as the engine reports it.
 *
 * `objectIds[i]` is the record at slot `i`. Slots are append-only and positional, which is what
 * makes a short mask safe to pad closed and a long one unsafe to truncate (KF-SAS-RQ-215).
 */
export interface SlotMap {
  /** The engine's own generation for this index. A bitmap is only valid against the one it was built from. */
  readonly generation: string;
  readonly objectIds: readonly string[];
}

/** Band membership over one slot ordering, valid for exactly one (bandVersion, generation) pair. */
export interface BandBitmaps {
  readonly organizationId: string;
  readonly bandVersion: bigint;
  readonly generation: string;
  readonly slotCount: number;
  /** `bands[band][slot]` is 1 when that slot's record sits in that band. */
  readonly bands: Readonly<Record<Band, Uint8Array>>;
  /**
   * Slots whose identifier resolved to no record in this organization.
   *
   * Never readable. An index that names a record the database does not have has either outrun it
   * or been pointed at a different one, and neither is a reason to show anybody anything.
   */
  readonly unresolved: Uint8Array;
}

export class BandVersionMoved extends Error {
  constructor(
    readonly expected: bigint,
    readonly actual: bigint,
  ) {
    super(
      `band version moved from ${expected} to ${actual}; the bitmaps were built against records ` +
        'that have since been reclassified and must be rebuilt rather than reused',
    );
    this.name = 'BandVersionMoved';
  }
}

export class GenerationMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `retrieval index generation is ${actual}, bitmaps were built for ${expected}; the slot ` +
        'ordering has moved and a mask built against the old one would scope the scan by a ' +
        'foreign ordering',
    );
    this.name = 'GenerationMismatch';
  }
}

/** The organization's current band version. Cheap: one row, primary-key lookup. */
export async function currentBandVersion(tx: Tx, organizationId: string): Promise<bigint> {
  const rows = await tx.query<{ version: string }>(
    'select /* retrieval.band-version */ version::text as version from retrieval.band_version where organization_id = $1',
    [organizationId],
  );
  // No row means no record has ever been written for this organization, so every band is empty
  // and version 0 is the honest answer rather than an error.
  return BigInt(rows[0]?.version ?? '0');
}

/**
 * Derive band membership for one slot ordering.
 *
 * Reads the version FIRST and again at the end, and refuses if it moved. A reclassification
 * landing mid-derivation would otherwise produce a bitmap that is neither the before state nor
 * the after — internally inconsistent in a way no version stamp would reveal, because the stamp
 * would name a state the bitmap never held.
 */
export async function buildBandBitmaps(
  tx: Tx,
  organizationId: string,
  slots: SlotMap,
): Promise<BandBitmaps> {
  const before = await currentBandVersion(tx, organizationId);

  const bands = Object.fromEntries(
    BANDS.map((band) => [band, new Uint8Array(slots.objectIds.length)]),
  ) as Record<Band, Uint8Array>;
  const unresolved = new Uint8Array(slots.objectIds.length);

  if (slots.objectIds.length > 0) {
    const rows = await tx.query<{ slot: number; classification: string | null }>(
      'select /* retrieval.slot-bands */ slot, classification from retrieval.slot_bands($1, $2::uuid[])',
      [organizationId, [...slots.objectIds]],
    );
    for (const row of rows) {
      const index = Number(row.slot) - 1; // `with ordinality` counts from one.
      const band = row.classification as Band | null;
      if (band === null || !(band in bands)) {
        // An unknown classification is treated exactly as an unresolved one. A band this build
        // does not know about is not a band it may guess the rank of.
        unresolved[index] = 1;
        continue;
      }
      bands[band][index] = 1;
    }
  }

  const after = await currentBandVersion(tx, organizationId);
  if (after !== before) throw new BandVersionMoved(before, after);

  return {
    organizationId,
    bandVersion: before,
    generation: slots.generation,
    slotCount: slots.objectIds.length,
    bands,
    unresolved,
  };
}

/**
 * The mask for one caller, over one index.
 *
 * A slot is scorable when the caller's ceiling reaches its band AND a live grant reaches the
 * record. The ceiling alone is not sufficient: access is a grant on every read (ADR 0016,
 * ADR 0027), and a person cleared to a level still reads only what a grant reaches.
 *
 * The returned mask is exactly `slotCount` long. It is never longer — a mask longer than the
 * index is refused by the engine, correctly, because it cannot be a stale bitmap and can only be
 * one built against a different index.
 */
export function maskFor(
  bitmaps: BandBitmaps,
  coverage: AccessCoverage,
  ceiling: Band,
  slots: SlotMap,
): Uint8Array {
  if (slots.generation !== bitmaps.generation) {
    throw new GenerationMismatch(bitmaps.generation, slots.generation);
  }
  if (slots.objectIds.length !== bitmaps.slotCount) {
    throw new GenerationMismatch(bitmaps.generation, slots.generation);
  }

  const reachable = BANDS.slice(0, BANDS.indexOf(ceiling) + 1);
  const mask = new Uint8Array(bitmaps.slotCount);

  for (let slot = 0; slot < bitmaps.slotCount; slot += 1) {
    if (bitmaps.unresolved[slot] === 1) continue;
    const band = reachable.find((candidate) => bitmaps.bands[candidate][slot] === 1);
    if (band === undefined) continue; // Above the ceiling, or in no band this build knows.
    const objectId = slots.objectIds[slot];
    if (objectId === undefined) continue;
    if (coveringGrants(coverage, objectId, band).length > 0) mask[slot] = 1;
  }

  return mask;
}

/** How many slots a mask admits. For the withholding ledger, and for telling an empty mask from a full one. */
export function admitted(mask: Uint8Array): number {
  let total = 0;
  for (const bit of mask) total += bit;
  return total;
}

export * from './protocol.js';
export * from './client.js';
